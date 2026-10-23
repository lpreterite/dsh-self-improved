/**
 * L1 提取管线（M2）：消费 L0 切片 → LLM 提取原子记忆 → 校验/去重 → 入库。
 *
 * 设计要点（吸取 dsh-tdai-memory 教训）：
 * - LLM 输出必须经 JSON 严格校验 + 兜底降级（坏输出 → 原文摘要），绝不静默失败；
 * - 提取绝不阻塞主对话（由调用方决定 await 时机）；
 * - 内容/查询统一 jieba 分词，去重用 token 重叠度。
 */
import type { MemoryStore, MemoryKind, ConversationSliceRecord } from "./storage.js";
import { tokenize } from "./storage.js";
import type { EmbeddingProvider } from "./recall.js";

export interface ExtractedMemoryDraft {
  kind: MemoryKind;
  content: string;
  importance: number;
}

/** LLM 调用抽象：输入提示词，返回模型文本（由宿主用 ctx.llm.stream 实现，测试可注入假实现） */
export interface ExtractCallLlm {
  (input: { system: string; user: string; sessionId: string; signal: AbortSignal }): Promise<string>;
}

export interface ExtractSettings {
  enabled: boolean;
  /** 定时轮询间隔（分钟） */
  intervalMinutes: number;
  /** 单次提取输入字符上限（超出取头尾） */
  batchMaxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** 去重：与已有记忆 token 重叠度过高则跳过 */
  dedup: boolean;
  /** 坏 JSON 时回退为"原文摘要"记忆，而不是静默丢弃 */
  fallbackOnBadJson: boolean;
  /** 丢弃重要度低于该值的提取结果（降噪） */
  minImportance: number;
  /** headless 一次性运行：flush 时同步排空（防 5s 关停超时） */
  flushDrain: boolean;
}

export interface ExtractPumpResult {
  sessions: number;
  memories: number;
  skipped: number;
  errors: number;
}

export const EXTRACT_SYSTEM_PROMPT = `你是长期记忆提取器。你的任务是从对话中提取"值得长期记住"的原子记忆。

要求：
1. 只输出一个 JSON 对象，不要输出任何其他文字、解释或代码块标记。
2. JSON 结构固定为：{"memories":[{"kind":"fact|preference|event|instruction","content":"一句话","importance":1-10}]}
3. kind 含义：fact=客观事实；preference=用户偏好/习惯；event=发生的事件；instruction=给未来 AI 的指令/约定。
4. content 必须是独立可检索的一句话（第三人称、不含"我说/用户说"），不超过 80 字。
5. importance 1-10：对长期协作价值越高分越高；琐碎寒暄不提取。
6. 不提取：API 密钥、密码、令牌等敏感凭据；临时性内容。
7. 没有值得记住的内容时输出 {"memories":[]}。`;

const SENSITIVE_RE = /\b(sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=])\b/i;

export class Extractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: ExtractSettings,
    private readonly callLlm: ExtractCallLlm,
    private readonly embedding: EmbeddingProvider | null = null,
  ) {}

  /** 处理所有有待处理切片的会话；返回汇总。防重入 + 节流。 */
  async pump(): Promise<ExtractPumpResult> {
    if (!this.settings.enabled) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    if (this.pumping) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    const now = Date.now();
    if (now - this.lastPumpAt < MIN_PUMP_INTERVAL_MS) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    this.pumping = true;
    this.lastPumpAt = now;
    try {
      const pending = this.store.pendingSessions();
      let memories = 0;
      let skipped = 0;
      let errors = 0;
      for (const p of pending) {
        try {
          const r = await this.extractForSession(p.sessionId, p.processedSeq, p.pendingSeq);
          memories += r.memories;
          skipped += r.skipped;
        } catch (error) {
          errors++;
          console.warn(
            "[dsh-self-improved] extract failed for",
            p.sessionId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return { sessions: pending.length, memories, skipped, errors };
    } finally {
      this.pumping = false;
    }
  }

  private pumping = false;
  private lastPumpAt = 0;

  private async extractForSession(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<{ memories: number; skipped: number }> {
    const slices = this.store.readSlices(sessionId, fromSeq, toSeq);
    if (slices.length === 0) {
      // 无新内容也推进水位，避免反复空转
      this.store.advanceProcessed(sessionId, toSeq);
      return { memories: 0, skipped: 0 };
    }
    const user = renderPrompt(slices, this.settings.batchMaxChars);
    const signal = AbortSignal.timeout(this.settings.timeoutMs);
    const text = await this.callLlm({ system: EXTRACT_SYSTEM_PROMPT, user, sessionId, signal });
    const drafts = this.parseMemories(text, user);

    let memories = 0;
    let skipped = 0;
    const inserted: Array<{ content: string; id: string }> = [];
    for (const draft of drafts) {
      if (draft.importance < this.settings.minImportance) {
        skipped++; // 低价值噪音直接丢弃（降噪）
        continue;
      }
      if (this.settings.dedup && this.isDuplicate(draft)) {
        skipped++;
        continue;
      }
      const record = this.store.insertMemory(draft);
      inserted.push({ content: record.content, id: record.id });
      memories++;
    }
    // 向量回填（可选）：配置了 embedding 时写入，供混合检索
    if (inserted.length > 0 && this.embedding) {
      try {
        const vectors = await this.embedding.embed(inserted.map((m) => m.content));
        inserted.forEach((m, i) => {
          if (vectors[i]?.length) this.store.upsertEmbedding(m.id, vectors[i]);
        });
      } catch (error) {
        console.warn("[dsh-self-improved] embedding backfill skipped:", String(error));
      }
    }
    this.store.advanceProcessed(sessionId, toSeq);
    return { memories, skipped };
  }

  /** 解析并校验 LLM 输出；坏输出走兜底（fallbackOnBadJson 时） */
  parseMemories(text: string, sourceSummary: string): ExtractedMemoryDraft[] {
    const json = extractJson(text);
    const drafts: ExtractedMemoryDraft[] = [];
    let parsedOk = false;
    if (json && typeof json === "object" && Array.isArray((json as { memories?: unknown }).memories)) {
      parsedOk = true;
      for (const item of (json as { memories: unknown[] }).memories) {
        if (!item || typeof item !== "object") continue;
        const raw = item as { kind?: unknown; content?: unknown; importance?: unknown };
        const kind = raw.kind as MemoryKind;
        const content = typeof raw.content === "string" ? raw.content.trim() : "";
        const importance = typeof raw.importance === "number" ? Math.round(raw.importance) : 5;
        if (!KINDS.has(kind)) continue;
        if (content.length < 2 || content.length > 500) continue;
        if (SENSITIVE_RE.test(content)) continue;
        drafts.push({ kind, content, importance: Math.max(1, Math.min(10, importance)) });
      }
    }
    // 兜底：仅当 JSON 解析失败（非"合法空结果"）且文本非空时，把原文摘要记为低重要度事件
    if (drafts.length === 0 && !parsedOk && this.settings.fallbackOnBadJson && text.trim()) {
      const summary = summarize(sourceSummary, 200);
      if (summary) {
        drafts.push({ kind: "event", content: `[自动摘要] ${summary}`, importance: 1 });
      }
    }
    return drafts;
  }

  /** 基础去重：与最近命中的记忆做 jieba token 重叠度判断 */
  private isDuplicate(draft: ExtractedMemoryDraft): boolean {
    const tokens = new Set(tokenize(draft.content).split(/\s+/).filter(Boolean));
    if (tokens.size === 0) return false;
    const hits = this.store.searchMemories(draft.content, { limit: 3 });
    for (const hit of hits) {
      const hitTokens = new Set(tokenize(hit.content).split(/\s+/).filter(Boolean));
      let inter = 0;
      for (const t of tokens) if (hitTokens.has(t)) inter++;
      const union = new Set([...tokens, ...hitTokens]).size;
      if (union > 0 && inter / union > 0.6) return true;
    }
    return false;
  }
}

const KINDS: ReadonlySet<string> = new Set(["fact", "preference", "event", "instruction"]);

/** 两次 pump 的最小间隔：DSH 会在多处 flush 检查点触发回调，避免 LLM 调用风暴 */
const MIN_PUMP_INTERVAL_MS = 30_000;

/** 渲染 LLM 输入：角色标注 + 头尾截断 */
function renderPrompt(slices: ConversationSliceRecord[], maxChars: number): string {
  const parts = slices.map((s) => {
    const role = s.type === "user" ? "用户" : s.type === "assistant" ? "AI" : "工具结果";
    return `${role}：${s.text}`;
  });
  const joined = parts.join("\n");
  if (joined.length <= maxChars) return joined;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return joined.slice(0, head) + "\n…[中间省略]…\n" + joined.slice(-tail);
}

/** 从模型文本中尽量提取 JSON（容忍代码块包裹/前后杂讯） */
export function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* 继续尝试 */
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function summarize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

/**
 * 自进化模块（M4）：
 * 1) 遗忘衰减：importance × recency × access 评分，低于阈值标记 decayed；过期 forgotten 清理；
 * 2) 技能合成：把高价值记忆（指令/事件）提炼为可复用 SOP，写入 dsh-skill 文件系统仓库
 *    （$DSH_HOME/skills/<name>/SKILL.md，YAML frontmatter；dsh-skill-filesystem watch 自动加载）。
 *
 * P0 去重（issue #1）：写入前做存量技能查重（相似度预过滤 + 三态协议 SKIP/UPDATE/NEW），
 * 撞名永不 fork 副本——dedupe 开启走三态判定；关闭时同撞名回退 M4 原版"已存在不覆盖"。
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, copyFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { MemoryStore } from "./storage.js";
import { extractJson } from "./extract.js";

export interface DecaySettings {
  enabled: boolean;
  /** 记忆至少存在多少天才能被衰减 */
  minAgeDays: number;
  /** 评分阈值，低于即标记 decayed */
  threshold: number;
  /** forgotten 记忆超过多少天被物理清理（0 = 不清理） */
  retentionDays: number;
  /** 活跃记忆总量上限（0 = 不限）；超限时自动把最低分记忆降级 */
  maxActiveMemories: number;
}

export interface SkillSynthesisSettings {
  enabled: boolean;
  /** 参与合成的记忆最低重要度 */
  minImportance: number;
  /** 技能根目录；留空 = $DSH_HOME/skills */
  skillsRoot: string;
  /** 合成技能的名称前缀（标识来源、避免与系统技能撞名）；留空 = 不加前缀 */
  prefix: string;
  /** 合成技能总数上限（0 = 不限）；达到后停止新合成 */
  maxSkills: number;
  /** 写入前查重（SKIP/UPDATE/NEW 三态协议）；缺省 true。关闭时撞名回退"已存在不覆盖"，任何配置下都不再 fork 副本 */
  dedupe?: boolean;
}

export interface EvolveCallLlm {
  (input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

/** 存量合成技能的摘要（供查重上下文与相似度预过滤使用） */
export interface SynthesizedSkillInfo {
  /** 目录名（含前缀），即 frontmatter 的 name */
  name: string;
  description: string;
  whenToUse: string;
  /** 正文（frontmatter 之后）前 N 字符 */
  bodyHead: string;
}

const SKILL_FORMAT_RULES = `输出一个 Markdown 文件，格式严格如下：
---
name: 技能名（小写 kebab-case，如 bump-pnpm-deps）
description: 一句话说明（30 字内）
whenToUse: 什么场景下使用
---
技能正文：触发条件、操作步骤（1. 2. 3.）、注意事项、反例。
只输出这个 Markdown，不要额外文字。`;

export const SKILL_SYSTEM_PROMPT = `你是技能提炼器。基于用户与 AI 协作中沉淀的记忆，提炼一条可复用的标准操作流程（SOP）技能。
${SKILL_FORMAT_RULES}`;

/** 有查重候选时附加的三态输出协议 */
export const SKILL_DEDUPE_PROTOCOL = `判定规则：
- 若下方"已有技能清单"中已有技能完全覆盖本次记忆主题：只输出一行 SKIP: <该技能名>，不要输出其他内容。
- 若高度相关但内容有明显缺失或过时：第一行输出 UPDATE: <该技能名>，随后另起一行输出合并后的完整技能 Markdown（frontmatter 的 name 必须为该技能名，正文格式同上）。
- 仅当没有任何技能可覆盖时，才输出一个全新技能的 Markdown。`;

/** 组装合成提示词：无候选 = 纯新建格式；有候选 = 追加技能清单与三态协议 */
export function buildSkillPrompt(candidates: SynthesizedSkillInfo[]): string {
  if (candidates.length === 0) return SKILL_SYSTEM_PROMPT;
  const list = candidates
    .map((c) => `- ${c.name} — ${c.description}${c.whenToUse ? `（适用：${c.whenToUse}）` : ""}`)
    .join("\n");
  return `${SKILL_SYSTEM_PROMPT}\n\n已有技能清单：\n${list}\n\n${SKILL_DEDUPE_PROTOCOL}`;
}

/** 记忆评分：importance × recency × (1 + log(1+access)) */
export function memoryScore(record: {
  importance: number;
  accessCount: number;
  createdAt: number;
}, now: number): number {
  const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 30); // 30 天半衰期
  return record.importance * recency * (1 + Math.log1p(record.accessCount));
}

/** 执行遗忘衰减与清理；返回衰减/清理计数 */
export function applyDecay(store: MemoryStore, settings: DecaySettings, now = Date.now()): { decayed: number; deleted: number } {
  if (!settings.enabled) return { decayed: 0, deleted: 0 };
  const memories = store.getActiveMemories(10_000);
  let decayed = 0;
  const minAgeMs = settings.minAgeDays * 86_400_000;
  for (const m of memories) {
    if (now - m.createdAt < minAgeMs) continue;
    if (memoryScore(m, now) < settings.threshold) {
      if (store.setMemoryStatus(m.id, "decayed")) decayed++;
    }
  }
  let deleted = 0;
  if (settings.retentionDays > 0) {
    deleted = store.deleteForgottenOlderThan(now - settings.retentionDays * 86_400_000);
  }
  // 总量上限：超出时把最低分活跃记忆降级，直到回到上限内
  if (settings.maxActiveMemories > 0) {
    const active = store.getActiveMemories(100_000);
    const overflow = active.length - settings.maxActiveMemories;
    if (overflow > 0) {
      const sorted = [...active].sort((a, b) => memoryScore(a, now) - memoryScore(b, now));
      for (let i = 0; i < overflow; i++) {
        if (store.setMemoryStatus(sorted[i].id, "decayed")) decayed++;
      }
    }
  }
  return { decayed, deleted };
}

/** 删除一个合成的技能目录（仅允许 dsi- 前缀或显式授权名，防路径穿越） */
export function deleteSkill(name: string, skillsRoot = ""): boolean {
  const trimmed = name.trim();
  // 只允许删除带前缀的合成技能（本插件产物）
  const prefix = "dsi-";
  if (!trimmed.startsWith(prefix)) return false;
  if (!/^dsi-[a-z0-9-]+$/.test(trimmed)) return false;
  const root = skillsRoot.trim() || defaultSkillsDir();
  const dir = join(root, trimmed);
  if (!existsSync(join(dir, "SKILL.md"))) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 统计已合成的技能数（带前缀的目录） */
export function countSynthesizedSkills(prefix: string, skillsRoot = ""): number {
  const root = skillsRoot.trim() || defaultSkillsDir();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .length;
  } catch {
    return 0;
  }
}

/** 技能内容摘要：sha256（用于撞名时的幂等判定） */
function hashContent(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

const withTrailingNewline = (text: string): string => (text.endsWith("\n") ? text : text + "\n");

/** 失败/拒绝产物落盘到 <store>/skills-debug/，便于排查（web 控制台日志用户看不到） */
export function persistDebug(store: MemoryStore, filename: string, content: string): void {
  try {
    mkdirSync(join(store.dir, "skills-debug"), { recursive: true });
    writeFileSync(join(store.dir, "skills-debug", filename), content, { encoding: "utf8" });
  } catch { /* noop */ }
}

/** 解析技能 Markdown：优先 frontmatter；无 frontmatter 时容错提取标题作为技能名 */
function parseSkillMarkdown(text: string): { name?: string; description?: string } | null {
  const fm = parseFrontmatter(text);
  if (fm.name && fm.description) return { name: fm.name, description: fm.description };
  // 容错：从一级标题提取技能名（转 kebab-case）
  const heading = text.match(/^#\s+([^\n]+)/m)?.[1]?.trim();
  if (heading && text.length > 80) {
    const name = heading
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (name) return { name };
  }
  return null;
}

/** 解析 frontmatter：返回 name/description/whenToUse 与正文（frontmatter 之后的部分） */
function parseFrontmatter(text: string): { name?: string; description?: string; whenToUse?: string; body?: string } {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return {};
  const fm = m[1];
  return {
    name: fm.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m)?.[1],
    description: fm.match(/^description:\s*(.+)/m)?.[1]?.trim(),
    whenToUse: fm.match(/^whenToUse:\s*(.+)/m)?.[1]?.trim(),
    body: (m[2] ?? "").trim(),
  };
}

/** 读取存量合成技能的摘要（只读目录名带前缀的技能；空 prefix = 全部技能目录） */
export function readSynthesizedSkills(prefix: string, skillsRoot = ""): SynthesizedSkillInfo[] {
  const root = skillsRoot.trim() || defaultSkillsDir();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d): SynthesizedSkillInfo | null => {
        try {
          const raw = readFileSync(join(root, d.name, "SKILL.md"), "utf8");
          const fm = parseFrontmatter(raw);
          return {
            name: d.name,
            description: fm.description ?? "",
            whenToUse: fm.whenToUse ?? "",
            bodyHead: (fm.body ?? raw).slice(0, 300),
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is SynthesizedSkillInfo => x !== null);
  } catch {
    return [];
  }
}

/** 分词：拉丁词（≥2 字符）+ CJK 二元组，供 jaccard 相似度使用 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(w);
  for (const seg of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (seg.length === 1) {
      tokens.add(seg);
      continue;
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.add(seg.slice(i, i + 2));
  }
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** 相似度预过滤：记忆池与存量技能比 jaccard，取 top-k（只让可能相关的技能进 LLM 上下文，控制 token 成本） */
export function pickCandidateSkills(
  memories: Array<{ kind: string; content: string }>,
  skills: SynthesizedSkillInfo[],
  k = 8,
): SynthesizedSkillInfo[] {
  const memTokens = tokenize(memories.map((m) => `${m.kind} ${m.content}`).join("\n"));
  return skills
    .map((s) => ({ s, score: jaccard(memTokens, tokenize(`${s.name} ${s.description} ${s.whenToUse} ${s.bodyHead}`)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.s);
}

/** 合成产物的三态：skip（已有技能覆盖）/ update（就地合并）/ new（全新技能） */
export type SynthesisOutcome =
  | { action: "skip"; name: string }
  | { action: "update"; name: string; text: string }
  | { action: "new"; text: string };

/** 解析三态输出协议：首行 SKIP: / UPDATE: <name>，否则按全新技能 Markdown 解析 */
export function parseSynthesisOutcome(text: string): SynthesisOutcome | null {
  const trimmed = text.trim();
  const skip = trimmed.match(/^SKIP:\s*([A-Za-z0-9-]+)/);
  if (skip) return { action: "skip", name: skip[1].toLowerCase() };
  const update = trimmed.match(/^UPDATE:\s*([A-Za-z0-9-]+)\s*\n([\s\S]+)$/);
  if (update) return { action: "update", name: update[1].toLowerCase(), text: update[2].trim() };
  const parsed = parseSkillMarkdown(trimmed);
  if (parsed) return { action: "new", text: trimmed };
  return null;
}

/** 技能合成：一次调用生成一条 SOP 并写入 dsh-skill 仓库；返回写入的技能数（P0 起：永不 fork 同名副本） */
export async function synthesizeSkills(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<number> {
  if (!settings.enabled) return 0;
  // 技能上限：已合成的 dsi-* 技能达到上限则跳过
  const prefix = (settings.prefix ?? "").trim();
  if (settings.maxSkills > 0 && prefix) {
    const root0 = skillsRoot.trim() || defaultSkillsDir();
    if (countSynthesizedSkills(prefix, root0) >= settings.maxSkills) {
      console.warn(`[dsh-self-improved] skill synthesis skipped: reached maxSkills=${settings.maxSkills}`);
      return 0;
    }
  }
  const memories = store.getActiveMemories(50, settings.minImportance);
  if (memories.length === 0) return 0;
  const root = skillsRoot.trim() || defaultSkillsDir();
  mkdirSync(root, { recursive: true });
  const dedupe = settings.dedupe !== false; // 缺省开启

  // 查重上下文：读取存量技能 → 相似度预过滤出候选（无候选时零额外成本，退回纯新建提示词）
  const candidates = dedupe ? pickCandidateSkills(memories, readSynthesizedSkills(prefix, root)) : [];

  const input = memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  const signal = AbortSignal.timeout(180_000);
  const text = (await callLlm({ system: buildSkillPrompt(candidates), user: input, signal })).trim();

  const outcome = parseSynthesisOutcome(text);
  if (!outcome) {
    persistDebug(store, "rejected-latest.txt", text);
    console.warn("[dsh-self-improved] skill synthesis rejected model output (see skills-debug/rejected-latest.txt):", text.slice(0, 120));
    return 0;
  }

  const candidateNames = new Set(candidates.map((c) => c.name.toLowerCase()));

  // —— SKIP：已有技能覆盖本主题，不写盘 ——
  if (outcome.action === "skip") return 0;

  // —— UPDATE：就地合并（校验目标必须是候选中的带前缀存量技能；覆盖前备份旧版） ——
  if (outcome.action === "update") {
    let target = outcome.name;
    if (!candidateNames.has(target) && candidateNames.has(`${prefix}${target}`)) target = `${prefix}${target}`;
    if (!prefix || !target.startsWith(prefix) || !candidateNames.has(target)) {
      persistDebug(store, `update-rejected-${Date.now()}.txt`, `target not in dedupe candidates: ${outcome.name}\n\n${outcome.text}`);
      return 0;
    }
    const dir = join(root, target);
    const file = join(dir, "SKILL.md");
    if (!existsSync(file)) {
      persistDebug(store, `update-rejected-${Date.now()}.txt`, `target file missing: ${target}\n\n${outcome.text}`);
      return 0;
    }
    // 合并产物必须可解析，且 name 与目标一致（防止 UPDATE 改名变相新建）
    const parsed = parseSkillMarkdown(outcome.text);
    if (!parsed?.name || parsed.name.toLowerCase() !== target) {
      persistDebug(store, `update-rejected-${Date.now()}.txt`, `name mismatch (want ${target})\n\n${outcome.text}`);
      return 0;
    }
    try {
      mkdirSync(join(store.dir, "skills-debug"), { recursive: true });
      copyFileSync(file, join(store.dir, "skills-debug", `backup-${target}-${Date.now()}.md`));
    } catch { /* noop */ }
    writeFileSync(file, withTrailingNewline(outcome.text), { encoding: "utf8" });
    return 1;
  }

  // —— NEW：全新技能（撞名：同内容幂等跳过；异内容保守跳过并落盘，永不 fork 副本） ——
  const parsed = parseSkillMarkdown(outcome.text);
  if (!parsed?.name) {
    persistDebug(store, "rejected-latest.txt", outcome.text);
    console.warn("[dsh-self-improved] skill synthesis rejected model output (see skills-debug/rejected-latest.txt):", outcome.text.slice(0, 120));
    return 0;
  }
  // 名称加前缀（标识来源 / 避免与系统技能撞名），并同步改写 frontmatter 的 name
  const baseName = prefix && !parsed.name.startsWith(prefix) ? `${prefix}${parsed.name}` : parsed.name;
  let finalText = outcome.text;
  if (baseName !== parsed.name) {
    finalText = outcome.text.replace(/^(name:\s*).*$/m, `name: ${baseName}`);
  }
  const dir = join(root, baseName);
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) {
    // 同内容 → 幂等，正常跳过；异内容 → 保守跳过（学习痕迹落 skills-debug，不产生副本）
    const old = readFileSync(file, "utf8");
    if (hashContent(finalText) === hashContent(old)) return 0;
    persistDebug(store, `collision-${baseName}-${Date.now()}.txt`, finalText);
    return 0;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, withTrailingNewline(finalText), { encoding: "utf8" });
  return 1;
}

export function defaultSkillsDir(): string {
  return join(resolveDshHome(undefined, process.env), "skills");
}

// ==================== P1：存量技能审计与合并（issue #1） ====================

/** 全量技能摘要（审计/合并用；body 不截断） */
export interface FullSkillInfo extends SynthesizedSkillInfo {
  body: string;
  mtimeMs: number;
}

/** 读取存量技能全文（目录名带前缀；空 prefix = 全部技能目录），按名称排序保证稳定输出 */
export function readSynthesizedSkillsFull(prefix: string, skillsRoot = ""): FullSkillInfo[] {
  const root = skillsRoot.trim() || defaultSkillsDir();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .map((d): FullSkillInfo | null => {
        try {
          const file = join(root, d.name, "SKILL.md");
          const raw = readFileSync(file, "utf8");
          const fm = parseFrontmatter(raw);
          return {
            name: d.name,
            description: fm.description ?? "",
            whenToUse: fm.whenToUse ?? "",
            bodyHead: (fm.body ?? raw).slice(0, 300),
            body: (fm.body ?? raw).trim(),
            mtimeMs: statSync(file).mtimeMs,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is FullSkillInfo => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** 退役信号统计：从记忆库扫 "invoked skill <name>" 事件（capture 入库），取每技能最近调用时间 */
export function collectInvocationStats(store: MemoryStore): Map<string, number> {
  const stats = new Map<string, number>();
  try {
    for (const m of store.listMemories({ limit: 2000 })) {
      if (m.status !== "active") continue;
      const match = m.content.match(/^invoked skill (\S+)$/);
      if (!match) continue;
      const prev = stats.get(match[1]) ?? 0;
      if (m.createdAt > prev) stats.set(match[1], m.createdAt);
    }
  } catch { /* 记忆库不可用时按"从未调用"处理 */ }
  return stats;
}

export const SKILL_AUDIT_SYSTEM_PROMPT = `你是技能库审计器。给定一组合成技能（name、description、whenToUse、正文）与其最近调用时间，找出主题重复的技能簇。
规则：
- 只把"同一经验域/同一 SOP 主题"的技能归为一簇；主题独立、各有侧重的不要硬凑成簇。
- 每簇选一个保留者（keeper）：内容最完整、最近验证、命名最清晰者优先。
- duplicates 里的技能之后会被删除，务必确认它们没有独立价值；uniqueNotes 摘录各副本独有的、值得并入保留者的细节要点（分号分隔，可为空字符串）。
- 输出严格 JSON，不要额外文字：
{"clusters":[{"keeper":"<name>","duplicates":["<name>"],"reason":"一句话","uniqueNotes":"要点；要点"}]}
没有重复簇时输出 {"clusters":[]}。`;

export interface SkillAuditCluster {
  keeper: string;
  duplicates: string[];
  reason: string;
  uniqueNotes: string;
}

export interface SkillAuditPlan {
  createdAt: number;
  skillsRoot: string;
  clusters: SkillAuditCluster[];
}

function readSkillRaw(root: string, name: string): string | null {
  try {
    const file = join(root, name, "SKILL.md");
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 渲染人读审计报告 */
function renderAuditReport(
  skills: FullSkillInfo[],
  invocations: Map<string, number>,
  plan: SkillAuditPlan,
): string {
  const lines: string[] = [];
  lines.push(`技能库审计 ${new Date(plan.createdAt).toLocaleString()} — 共 ${skills.length} 个技能`);
  if (plan.clusters.length === 0) {
    lines.push("未发现重复簇。");
  } else {
    lines.push(`发现 ${plan.clusters.length} 个重复簇：`);
    for (const c of plan.clusters) {
      lines.push(`- [${c.keeper}] ← 删除 ${c.duplicates.join("、")}（${c.reason}）`);
      if (c.uniqueNotes) lines.push(`  独有细节待并入：${c.uniqueNotes}`);
    }
  }
  const neverUsed = skills.filter((s) => !invocations.has(s.name)).map((s) => s.name);
  if (neverUsed.length > 0) lines.push(`从未被调用的技能（N 天零调用，候选退役信号，仅提示不强删）：${neverUsed.join("、")}`);
  lines.push("确认无误后执行 /memory skills-merge --apply 执行合并（保留者就地更新，删除者与旧版均有备份）。");
  return lines.join("\n");
}

/** 技能库审计：全量读取 → LLM 聚类 → 校验簇合法性（名字必须真实存在、不得自删）→ 报告+计划落盘。不动任何技能文件。 */
export async function auditSkills(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<{ report: string; plan: SkillAuditPlan }> {
  const root = skillsRoot.trim() || defaultSkillsDir();
  const prefix = (settings.prefix ?? "").trim();
  const skills = readSynthesizedSkillsFull(prefix, root);
  if (skills.length === 0) {
    const plan: SkillAuditPlan = { createdAt: Date.now(), skillsRoot: root, clusters: [] };
    return { report: "技能目录为空，无需审计。", plan };
  }
  const invocations = collectInvocationStats(store);
  const input = skills
    .map((s) => {
      const last = invocations.get(s.name);
      return `### ${s.name}${last ? `（最近调用 ${new Date(last).toISOString().slice(0, 10)}）` : "（从未被调用）"}\ndescription: ${s.description}\nwhenToUse: ${s.whenToUse}\n正文：\n${s.body.slice(0, 600)}`;
    })
    .join("\n\n");
  const signal = AbortSignal.timeout(180_000);
  const text = (await callLlm({ system: SKILL_AUDIT_SYSTEM_PROMPT, user: input, signal })).trim();
  const parsed = extractJson(text) as { clusters?: SkillAuditCluster[] } | null;
  const known = new Set(skills.map((s) => s.name));
  // 簇合法性校验：keeper 必须真实存在；duplicate 必须存在且 ≠ keeper；去重去空
  const clusters = (Array.isArray(parsed?.clusters) ? parsed!.clusters : [])
    .map((c) => ({
      keeper: String(c?.keeper ?? "").trim(),
      duplicates: Array.from(new Set((Array.isArray(c?.duplicates) ? c.duplicates : []).map((d) => String(d ?? "").trim()).filter(Boolean))),
      reason: String(c?.reason ?? "").trim(),
      uniqueNotes: String(c?.uniqueNotes ?? "").trim(),
    }))
    .filter((c) => known.has(c.keeper) && c.duplicates.length > 0 && c.duplicates.every((d) => known.has(d) && d !== c.keeper));
  const plan: SkillAuditPlan = { createdAt: Date.now(), skillsRoot: root, clusters };
  const report = renderAuditReport(skills, invocations, plan);
  persistDebug(store, "skills-audit-latest.json", JSON.stringify(plan, null, 2));
  persistDebug(store, "skills-audit-report-latest.txt", report);
  return { report, plan };
}

/** 读取已落盘的最新审计计划（无则 null） */
export function loadAuditPlan(store: MemoryStore): SkillAuditPlan | null {
  try {
    const file = join(store.dir, "skills-debug", "skills-audit-latest.json");
    if (!existsSync(file)) return null;
    const plan = JSON.parse(readFileSync(file, "utf8")) as SkillAuditPlan;
    return Array.isArray(plan?.clusters) ? plan : null;
  } catch {
    return null;
  }
}

export const SKILL_MERGE_SYSTEM_PROMPT = `你是技能合并器。把若干主题重复的技能合并为一个权威版本。
- 以"保留者"为骨架，融入各"待合并删除"副本中独有的有效细节，删除彼此重复与已过时的内容。
- 输出保留者的完整 Markdown（frontmatter 的 name 必须与保留者名完全一致），保持触发条件/操作步骤/注意事项/反例的结构。
- 只输出这个 Markdown，不要额外文字。`;

/** 执行合并计划：每簇一次 LLM 合并 → 校验产物 → 全量备份 → 覆盖保留者 → 删除副本。返回人读结果。 */
export async function applySkillMerge(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  plan: SkillAuditPlan,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<string> {
  const root = skillsRoot.trim() || defaultSkillsDir();
  const prefix = (settings.prefix ?? "").trim();
  const lines: string[] = [`技能合并（apply）${new Date().toLocaleString()}`];
  if (!Array.isArray(plan?.clusters) || plan.clusters.length === 0) {
    return "合并计划为空（先执行 /memory skills-audit）。";
  }
  const signal = AbortSignal.timeout(180_000);
  for (const c of plan.clusters) {
    if (!prefix || !c.keeper.startsWith(prefix)) {
      lines.push(`- 跳过 ${c.keeper}：保留者不带合成前缀（${prefix || "未配置"}），拒绝操作`);
      continue;
    }
    const keeperRaw = readSkillRaw(root, c.keeper);
    if (keeperRaw === null) {
      lines.push(`- 跳过 ${c.keeper}：SKILL.md 不存在`);
      continue;
    }
    const dups = c.duplicates
      .map((d) => ({ name: d, raw: readSkillRaw(root, d) }))
      .filter((x): x is { name: string; raw: string } => x.raw !== null);
    if (dups.length === 0) {
      lines.push(`- 跳过 ${c.keeper}：副本均已不存在（可能已合并过）`);
      continue;
    }
    const input = [
      `### 保留者：${c.keeper}\n${keeperRaw}`,
      ...dups.map((d) => `### 待合并删除：${d.name}${c.uniqueNotes ? `\n审计标注的独有细节：${c.uniqueNotes}` : ""}\n${d.raw}`),
    ].join("\n\n");
    let merged: string;
    try {
      merged = (await callLlm({ system: SKILL_MERGE_SYSTEM_PROMPT, user: input, signal })).trim();
    } catch (e) {
      lines.push(`- 失败 ${c.keeper}：合并 LLM 调用异常 ${String(e)}`);
      continue;
    }
    const parsed = parseSkillMarkdown(merged);
    if (!parsed?.name || parsed.name.toLowerCase() !== c.keeper.toLowerCase()) {
      persistDebug(store, `merge-rejected-${c.keeper}-${Date.now()}.txt`, merged);
      lines.push(`- 拒绝 ${c.keeper}：合并产物 name 不符或不可解析（原文落 skills-debug/）`);
      continue;
    }
    const ts = Date.now();
    for (const name of [c.keeper, ...dups.map((d) => d.name)]) {
      const raw = readSkillRaw(root, name);
      if (raw !== null) persistDebug(store, `backup-${name}-${ts}.md`, raw);
    }
    writeFileSync(join(root, c.keeper, "SKILL.md"), withTrailingNewline(merged), { encoding: "utf8" });
    for (const d of dups) deleteSkill(d.name, root);
    lines.push(`- ✅ ${c.keeper} ← 合并并删除 ${dups.map((d) => d.name).join("、")}（全部旧版有备份）`);
  }
  const out = lines.join("\n");
  persistDebug(store, "skills-merge-result-latest.txt", out);
  return out;
}

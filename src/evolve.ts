/**
 * 自进化模块（M4）：
 * 1) 遗忘衰减：importance × recency × access 评分，低于阈值标记 decayed；过期 forgotten 清理；
 * 2) 技能合成：把高价值记忆（指令/事件）提炼为可复用 SOP，写入 dsh-skill 文件系统仓库
 *    （$DSH_HOME/skills/<name>/SKILL.md，YAML frontmatter；dsh-skill-filesystem watch 自动加载）。
 *
 * P0 去重（issue #1）：写入前做存量技能查重（相似度预过滤 + 三态协议 SKIP/UPDATE/NEW），
 * 撞名永不 fork 副本——dedupe 开启走三态判定；关闭时同撞名回退 M4 原版"已存在不覆盖"。
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { MemoryStore } from "./storage.js";

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
function persistDebug(store: MemoryStore, filename: string, content: string): void {
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

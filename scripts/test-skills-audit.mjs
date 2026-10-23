/**
 * P1 单元测试（issue #1）：技能库审计/合并 + 技能调用退役信号捕获 + /memory skills-* 子命令。
 * 运行：TEST_DIR=<dir> node scripts/test-skills-audit.mjs
 */
import { rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { installCapture, skillInvocationName } from "../lib/capture.js";
import { auditSkills, applySkillMerge, loadAuditPlan } from "../lib/evolve.js";
import { handleMemoryCommand } from "../lib/commands.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-test", "p1-unit");
rmSync(dir, { recursive: true, force: true });
const skillsRoot = join(dir, "skills");
mkdirSync(skillsRoot, { recursive: true });
const store = new MemoryStore(join(dir, "memory"));

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

const writeSkill = (name, description, body) => {
  mkdirSync(join(skillsRoot, name), { recursive: true });
  writeFileSync(join(skillsRoot, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\nwhenToUse: ${description}\n---\n${body}`);
};
writeSkill("dsi-alpha", "用 pnpm 更新依赖", "旧版 alpha 正文：pnpm update 流程。");
writeSkill("dsi-alpha-notes", "pnpm 依赖更新备注", "独有细节：lockfile 必须同批提交。");
writeSkill("dsi-alpha-old", "pnpm 升级（旧）", "过时步骤：使用 npm update。");
writeSkill("dsi-beta", "nginx 部署静态站点", "beta 正文：nginx server 块。");
writeSkill("dsi-gamma", "git rebase 流程", "gamma 正文：rebase --onto。");

// ---------- 1) skillInvocationName ----------
const invokeEvent = { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "<skill_content>" }], source: { kind: "skill-invocation", name: "dynamic-ui", form: "instructions" } } };
const nestedEvent = { type: "user/message", seq: 2, data: { message: { source: { kind: "skill-invocation", name: "wiki-query" } }, content: [{ type: "text", text: "x" }] } };
const plainEvent = { type: "user/message", seq: 3, data: { content: [{ type: "text", text: "普通话语" }] } };
check("识别顶层 source 的技能调用", skillInvocationName(invokeEvent) === "dynamic-ui");
check("识别嵌套 message.source 的技能调用", skillInvocationName(nestedEvent) === "wiki-query");
check("普通消息不误判", skillInvocationName(plainEvent) === null && skillInvocationName({ type: "tool/result", seq: 4, data: {} }) === null);

// ---------- 2) capture：调用注入记退役信号、不进提取语料 ----------
const handlers = {};
const fakeCtx = { on: (ev, fn) => { handlers[ev] = fn; } };
let flushCount = 0;
installCapture(fakeCtx, store, { enabled: () => true }, () => { flushCount++; });
const userEvent = { type: "user/message", seq: 5, data: { content: [{ type: "text", text: "帮我看下这个问题" }] } };
await handlers["session/flush"]({ id: "s1", snapshotEvents: () => [invokeEvent, nestedEvent, plainEvent, userEvent] });
const mems = store.listMemories({ limit: 50 }).filter((m) => m.content.startsWith("invoked skill "));
check("两次技能调用各记一条退役信号", mems.length === 2 && mems.every((m) => m.kind === "event" && m.importance === 3), JSON.stringify(mems.map((m) => m.content)));
const pending = store.pendingSessions().find((p) => p.sessionId === "s1");
check("普通消息仍进提取语料（水位推进）", pending?.pendingSeq === 5, JSON.stringify(pending));
check("捕获回调仍被触发", flushCount === 1);

// ---------- 3) auditSkills：聚类 + 非法簇过滤 + 落盘 ----------
// 真实调用记录（应出现在报告里）
store.insertMemory({ kind: "event", content: "invoked skill dsi-beta", importance: 3 });
const auditLlm = async ({ system, user }) => {
  if (!system.includes("技能库审计器")) throw new Error("unexpected prompt");
  check("审计提示词含全部技能与调用统计", user.includes("dsi-alpha-old") && user.includes("从未被调用") && user.includes("最近调用"), user.slice(0, 80));
  return JSON.stringify({
    clusters: [
      { keeper: "dsi-alpha", duplicates: ["dsi-alpha-notes", "dsi-alpha-old"], reason: "同一主题三个变体", uniqueNotes: "lockfile 必须同批提交" },
      { keeper: "dsi-不存在", duplicates: ["dsi-beta"], reason: "伪造簇应被过滤" },
      { keeper: "dsi-gamma", duplicates: ["dsi-gamma"], reason: "自删簇应被过滤" },
    ],
  });
};
const { report, plan } = await auditSkills(store, auditLlm, { enabled: true, minImportance: 7, skillsRoot, prefix: "dsi-", maxSkills: 0 }, skillsRoot);
check("非法簇被过滤（仅保留合法 1 簇）", plan.clusters.length === 1 && plan.clusters[0].keeper === "dsi-alpha" && plan.clusters[0].duplicates.length === 2, JSON.stringify(plan.clusters));
check("审计计划落盘", loadAuditPlan(store)?.clusters.length === 1);
check("报告含簇/独有细节/未调用提示", report.includes("[dsi-alpha]") && report.includes("lockfile") && report.includes("从未被调用"));
check("审计不动技能文件", existsSync(join(skillsRoot, "dsi-alpha-notes", "SKILL.md")));
// 调用统计：dsi-beta 最近被调用过
check("报告正确区分已调用技能", !report.includes("dsi-beta、") && (report.match(/从未被调用的技能[^\n]*/) ?? [""])[0].includes("dsi-alpha"));

// ---------- 4) /memory 子命令 ----------
let r = handleMemoryCommand(store, "skills-merge");
check("skills-merge dry 预览计划", r.kind === "success" && r.text.includes("[dsi-alpha]") && r.text.includes("--apply"));
r = handleMemoryCommand(store, "skills-audit");
check("skills-audit 未安装时报错", r.kind === "error");
r = handleMemoryCommand(store, "skills-audit", { skillsAudit: async () => "ok" });
check("skills-audit 已安装时触发", r.kind === "success" && r.text.includes("skills-report"));
r = handleMemoryCommand(store, "skills-report");
check("skills-report 读到审计报告", r.text.includes("最近审计报告"));

// ---------- 5) applySkillMerge：合并/删除/备份/拒绝 ----------
const alphaFile = join(skillsRoot, "dsi-alpha", "SKILL.md");
const beforeAlpha = readFileSync(alphaFile, "utf8");
const mergeLlm = async ({ system, user }) => {
  if (!system.includes("技能合并器")) throw new Error("unexpected prompt");
  check("合并提示词含保留者与副本全文", user.includes("保留者：dsi-alpha") && user.includes("待合并删除：dsi-alpha-old") && user.includes("lockfile 必须同批提交"));
  return `---\nname: dsi-alpha\ndescription: 用 pnpm 更新依赖（合并版）\nwhenToUse: 更新项目依赖时\n---\n合并后正文：pnpm update 流程；lockfile 必须同批提交。`;
};
const out = await applySkillMerge(store, mergeLlm, plan, { enabled: true, minImportance: 7, skillsRoot, prefix: "dsi-", maxSkills: 0 }, skillsRoot);
check("合并执行：保留者就地更新", readFileSync(alphaFile, "utf8").includes("合并版") && readFileSync(alphaFile, "utf8").includes("lockfile 必须同批提交"));
check("合并执行：副本被删除", !existsSync(join(skillsRoot, "dsi-alpha-notes", "SKILL.md")) && !existsSync(join(skillsRoot, "dsi-alpha-old", "SKILL.md")));
check("合并执行：独立技能不受影响", existsSync(join(skillsRoot, "dsi-beta", "SKILL.md")) && existsSync(join(skillsRoot, "dsi-gamma", "SKILL.md")));
const dbg = join(store.dir, "skills-debug");
const backups = existsSync(dbg) ? readdirSync(dbg).filter((f) => f.startsWith("backup-")) : [];
check("合并执行：三个旧版均有备份", backups.length >= 3, backups.join(","));
check("合并结果落盘", existsSync(join(dbg, "skills-merge-result-latest.txt")) && out.includes("✅"));

// 拒绝路径：合并产物 name 不符 → 原文件不动 + rejected 落盘
writeSkill("dsi-delta", "docker 部署", "delta 正文。");
writeSkill("dsi-delta-tips", "docker 部署备注", "独有：--restart unless-stopped。");
const badPlan = { createdAt: Date.now(), skillsRoot, clusters: [{ keeper: "dsi-delta", duplicates: ["dsi-delta-tips"], reason: "r", uniqueNotes: "" }] };
const badLlm = async () => `---\nname: dsi-另外的名字\ndescription: x\n---\n内容`;
const out2 = await applySkillMerge(store, badLlm, badPlan, { enabled: true, minImportance: 7, skillsRoot, prefix: "dsi-", maxSkills: 0 }, skillsRoot);
check("产物名不符被拒绝", out2.includes("拒绝 dsi-delta") && readFileSync(join(skillsRoot, "dsi-delta", "SKILL.md"), "utf8").includes("delta 正文") && existsSync(join(skillsRoot, "dsi-delta-tips", "SKILL.md")));
check("拒绝原文落盘", existsSync(dbg) && readdirSync(dbg).some((f) => f.startsWith("merge-rejected-dsi-delta-")));

// 非前缀保留者拒绝
const evilPlan = { createdAt: Date.now(), skillsRoot, clusters: [{ keeper: "not-prefix", duplicates: ["dsi-beta"], reason: "r", uniqueNotes: "" }] };
const out3 = await applySkillMerge(store, mergeLlm, evilPlan, { enabled: true, minImportance: 7, skillsRoot, prefix: "dsi-", maxSkills: 0 }, skillsRoot);
check("非合成前缀的保留者拒绝操作", out3.includes("拒绝操作") && existsSync(join(skillsRoot, "dsi-beta", "SKILL.md")));

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 重试账本：登记「暂时性失败（网络 / 限速 / 超时）、值得按周期重试」的会话，
 * 以及重试到底后放弃的会话（不再重试）。
 *
 * 落盘成 JSON（`<DSH_HOME>/auto-resume/retry-ledger.json`）：重启后启动扫描
 * 还能认得「已放弃、别再碰」的会话，也认得「还在重试周期里」的会话。
 *
 * 放弃标记会自然过期：会话后来有了新动静（日志尾部时间晚于放弃时的尾部），
 * 说明它往前走了，标记作废，该登记还登记。
 *
 * @module @goodjin2/dsh-auto-resume/retry-ledger
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isOverloadErrorDetail } from "./classify.js";
/**
 * 生成一条活跃登记：按每个会话自己的「下次到期时间」驱动周期重试。
 *
 * - 普通暂时性失败：`dueAt = now + retryIntervalMs`，沿用 10 分钟一次的节奏；
 * - 「服务暂时不可用」类（529/集群负载、500 等 5xx、api_error、中文网络错误、
 *   「请稍后重试」）：`overload` 打标、`dueAt = now + overloadRetryDelayMs`，
 *   等 5 分钟后只重试一次就收手。
 *
 * 所有条目都带 `dueAt`，周期心跳就只需一个短间隔，到没到点由账本说了算（重启也不丢）。
 * 纯函数，两个登记入口（会话事件广播、启动扫描）共用，避免两边判定漂移。
 */
export function makeActiveRetryEntry(input) {
    const { sessionId, detail, now, existing, parentId, overloadRetryDelayMs, retryIntervalMs } = input;
    const overload = isOverloadErrorDetail(detail);
    const base = {
        sessionId,
        ...(detail === undefined ? {} : { detail }),
        tailTime: now,
        attempts: existing?.attempts ?? 0,
        failures: existing?.failures ?? 0,
        registeredAt: existing?.registeredAt ?? now,
        ...(parentId === undefined ? {} : { parentId }),
        // 老账本里没有 dueAt 的条目：缺字段就当「这轮到期」，重投后自愈成有 dueAt。
        dueAt: existing?.dueAt ?? now + (overload ? overloadRetryDelayMs : retryIntervalMs),
    };
    if (!overload)
        return base;
    // 重复登记同一「服务暂时不可用」会话：已在等待/已试过的不重置到期与计数，否则服务每次
    // 继续报同类错误都会把「等 5 分钟」无限往后推，永远等不到重投。
    return {
        ...base,
        overload: true,
        overloadAttempts: existing?.overloadAttempts ?? 0,
    };
}
/** 空账本。 */
export function emptyLedger() {
    return { active: {}, abandoned: {} };
}
/** 插件自己的数据目录：`<DSH_HOME>/auto-resume`，缺省 `~/.dsh/auto-resume`。 */
export function pluginDataDir() {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(home, 'auto-resume');
}
/** 重试账本文件路径。 */
export function retryLedgerPath(dataDir = pluginDataDir()) {
    return join(dataDir, 'retry-ledger.json');
}
/** 读账本：文件缺失或读不动回空账本（账本坏了不该带崩扫描）。 */
export function loadRetryLedger(path) {
    try {
        const raw = JSON.parse(readFileSync(path, 'utf8'));
        return {
            active: raw.active && typeof raw.active === 'object' ? raw.active : {},
            abandoned: raw.abandoned && typeof raw.abandoned === 'object' ? raw.abandoned : {},
        };
    }
    catch {
        return emptyLedger();
    }
}
/** 写账本（目录不存在就建；写失败向上抛——账本写不进去，重试周期就是空转）。 */
export function saveRetryLedger(path, ledger) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}
/**
 * 放弃标记在这里是否仍然作数：标记在案，且会话的日志尾部没有晚于放弃时的尾部
 * ——会话后来往前走了，标记就过期了。
 */
export function isAbandonedHere(ledger, sessionId, lastEventTime) {
    const entry = ledger.abandoned[sessionId];
    if (entry === undefined)
        return undefined;
    return lastEventTime > entry.tailTime ? undefined : entry;
}

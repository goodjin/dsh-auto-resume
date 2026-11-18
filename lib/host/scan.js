/**
 * 全量会话扫描编排：枚举 → 过滤 → 预筛 → 判定 → 账目行。
 *
 * 每个会话独立成账：任何一个读取失败只记一行 error 跳过，不拦其余会话。
 * 顺序三层过滤都在读事件之前完成（子代理、已归档、运行中），mtime 预筛
 * 借 `sessionPersistence.stat` 拿日志路径再读文件时间——早于窗口起点的旧
 * 会话直接跳过，免整读大日志。
 *
 * @module @goodjin2/dsh-auto-resume/scan
 */
import { classifySession } from "./classify.js";
import { catalogChildren, hasLocalSession, reportedChildIds } from "./children.js";
/** 从判定结果折出账目行。 */
function ledgerRow(record, verdict) {
    const base = {
        sessionId: record.header.id,
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        action: verdict.action,
        cause: verdict.cause,
        lastTime: verdict.lastTime,
    };
    return verdict.action === 'continue' && verdict.detail !== undefined
        ? { ...base, detail: verdict.detail }
        : base;
}
/** 有一行 skip 账目的小工具。 */
function skipRow(record, cause) {
    return { sessionId: record.header.id, action: 'skip', cause, lastTime: 0 };
}
/**
 * 扫描全部会话，返回账目行（`action === 'continue'` 的行即投递候选）。
 * 单会话与整场枚举的失败都折成 error 账目行，不外抛。
 *
 * 成本护栏（2026-11-07 现场：全量 observeSession 把宿主堆读爆）：先按 mtime
 * 过滤并降序排，只对最近 `maxObservations` 个做整读；mtime 拿不到的会话直接
 * 跳过（fail closed）——中断必然发生在最近，旧会话不读也不漏。
 */
export async function scanSessions(hosts, options, io, progress, recent) {
    // 快速通道优先：fs 直查候选，不碰宿主逐会话枚举与 stat（有挂死先例）。
    if (recent !== undefined)
        return scanViaRecent(hosts, options, recent, progress);
    let records;
    try {
        records = await hosts.sessionQuery.listSessions();
    }
    catch (error) {
        return [skipRowOf('all', `error: 列举会话失败：${messageOf(error)}`)];
    }
    progress?.(0, records.length);
    const archived = new Set(hosts.workspaceRegistry.archivedSessionIds);
    const rows = [];
    const recentCandidates = [];
    let scanned = 0;
    for (const record of records) {
        const head = await headRow(hosts, options, io, record, archived);
        scanned += 1;
        // mtime 有效 = 进入整读候选（行由 observeRow 出）；否则 head.row 就是最终账目。
        if (head.mtime !== undefined)
            recentCandidates.push({ record, mtime: head.mtime });
        else
            rows.push(head.row);
        if (scanned % 200 === 0)
            progress?.(scanned, records.length);
    }
    progress?.(scanned, records.length);
    recentCandidates.sort((a, b) => b.mtime - a.mtime);
    const budget = { left: options.maxChildObservations };
    for (const { record } of recentCandidates.slice(0, Math.max(options.maxObservations, 0))) {
        for (const row of await judgeCandidate(hosts, record.header.id, options, budget)) {
            rows.push({
                ...row,
                ...(record.header.cwd === undefined || row.parentSessionId !== undefined ? {} : { cwd: record.header.cwd }),
            });
        }
    }
    return rows;
}
/** 无会话上下文的整场失败账目行（sessionId 占位）。 */
function skipRowOf(sessionId, cause) {
    return { sessionId, action: 'skip', cause, lastTime: 0 };
}
/** 头部过滤：子代理/归档/运行中直接跳过；mtime 预筛决定是否值得整读。 */
async function headRow(hosts, options, io, record, archived) {
    try {
        const header = record.header;
        if (header.origin === 'subagent' || header.parentSession !== undefined) {
            return { row: skipRow(record, 'subagent'), mtime: undefined };
        }
        if (archived.has(header.id))
            return { row: skipRow(record, 'archived'), mtime: undefined };
        const live = hosts.agents.get(header.id);
        if (live?.status === 'running')
            return { row: skipRow(record, 'running'), mtime: undefined };
        // mtime 预筛：早于窗口起点跳过；**拿不到时间也跳过**（fail closed）——
        // 2026-11-07 现场：预筛缺席时全量 observeSession 数千会话，把宿主堆读爆。
        // 中断必然发生在最近，mtime 不可知的旧会话不读也不漏。
        const mtime = await mtimeOf(hosts, header.id, io);
        if (mtime === undefined)
            return { row: skipRow(record, 'mtime-unknown'), mtime: undefined };
        if (options.now - mtime > options.lookbackHours * 3_600_000) {
            return { row: skipRow(record, 'outside-window'), mtime: undefined };
        }
        return { row: skipRow(record, 'pending-observation'), mtime };
    }
    catch (error) {
        return { row: { ...skipRow(record, `error: ${messageOf(error)}`), lastTime: 0 }, mtime: undefined };
    }
}
/** 经 stat 拿日志路径再读文件时间；任一环缺席都回 undefined（不预筛）。 */
async function mtimeOf(hosts, sessionId, io) {
    const stat = (await hosts.sessionPersistence?.stat(sessionId))?.location?.path;
    if (stat === undefined)
        return undefined;
    return io.statMtime(stat);
}
/** 错误的一句话形式。 */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 单个观察的硬超时：宿主 observeSession 对损坏日志也可能不返回。 */
const OBSERVE_TIMEOUT_MS = 15_000;
/** 只有 sessionId 可用时的账目行（fs 通道没有 header，cwd 缺席）。 */
function ledgerRowOfId(sessionId, verdict) {
    return {
        sessionId,
        action: verdict.action,
        cause: verdict.cause,
        lastTime: verdict.lastTime,
        ...(verdict.action === 'continue' && verdict.detail !== undefined ? { detail: verdict.detail } : {}),
    };
}
/** 会话头是否表明它是子代理会话（子会话归父会话路由管，不单独继续）。 */
function isSubagentHeader(header) {
    if (header === undefined)
        return false;
    return header.origin === 'subagent' || header.parentSession !== undefined;
}
/** 带硬超时的观察：超时折成 error 账目行，不拖死整场扫描。 */
async function observeRowTimed(hosts, sessionId, options) {
    const observed = await observeTimed(hosts, sessionId);
    if (!observed.ok) {
        return { sessionId, action: 'skip', cause: `error: ${observed.detail}`, lastTime: 0 };
    }
    try {
        // 子代理会话归父会话路由管：观察租约带头，头里认得出就当场跳过，
        // 免得投一次被宿主回「owned by subagent routing」。
        if (isSubagentHeader(observed.observation.header)) {
            return { sessionId, action: 'skip', cause: 'subagent', lastTime: 0 };
        }
        return ledgerRowOfId(sessionId, classifySession(observed.observation.events, options));
    }
    finally {
        observed.observation[Symbol.dispose]?.();
    }
}
/** 带硬超时的观察：拿不到就折成失败摘要，不抛。 */
async function observeTimed(hosts, sessionId) {
    try {
        const observation = await Promise.race([
            hosts.sessionQuery.observeSession(sessionId),
            new Promise((_, reject) => {
                const timer = setTimeout(() => reject(new Error(`observeSession 超时（${OBSERVE_TIMEOUT_MS}ms）`)), OBSERVE_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
        return { ok: true, observation };
    }
    catch (error) {
        return { ok: false, detail: messageOf(error) };
    }
}
/**
 * 判定一个候选会话，返回账目行（可能不止一行：主会话 + 需要续的子会话）。
 *
 * 主会话自己异常收尾 → 照旧续它；
 * 主会话正常收尾（模型结束轮次去等子代理）→ 看它的子代理目录：若某个子会话
 * 自己也是异常收尾且没向主会话报告过，那**该续的是子会话本身**——主会话不动
 * （它没被打扰，不会重做已完成的活），子会话跑完会由宿主把结算通知送到主会话。
 */
async function judgeCandidate(hosts, sessionId, options, budget) {
    const observed = await observeTimed(hosts, sessionId);
    if (!observed.ok) {
        return [{ sessionId, action: 'skip', cause: `error: ${observed.detail}`, lastTime: 0 }];
    }
    try {
        if (isSubagentHeader(observed.observation.header)) {
            return [{ sessionId, action: 'skip', cause: 'subagent', lastTime: 0 }];
        }
        const events = observed.observation.events;
        // 已放弃（连续重试失败到上限）且之后没有新动静 → 不再重试；
        // 会话有新动静了 → 标记过期，顺手删掉（不再只是被忽略地留着）。
        const abandonedEntry = options.abandoned?.get(sessionId);
        if (abandonedEntry !== undefined) {
            if (events.at(-1).time <= abandonedEntry.tailTime) {
                return [{ sessionId, action: 'skip', cause: 'no-more-retries', lastTime: events.at(-1).time }];
            }
            options.clearAbandoned?.(sessionId);
        }
        const verdict = classifySession(events, options);
        if (verdict.action === 'continue' || verdict.cause !== 'normal-end') {
            return [ledgerRowOfId(sessionId, verdict)];
        }
        const { rows, notes } = await pendingChildRows(hosts, sessionId, events, options, budget);
        const parentRow = {
            ...ledgerRowOfId(sessionId, verdict),
            ...(notes.length === 0 ? {} : { childNotes: notes }),
        };
        return [parentRow, ...rows];
    }
    finally {
        observed.observation[Symbol.dispose]?.();
    }
}
/**
 * 找出父会话下「被中断、值得恢复」的子会话，产出它们的投递行。
 *
 * 子会话的日志说了算：轮次还开着（宿主冷读补 `interrupted`）或异常收尾 → 续。
 * 已经向主会话报告过结果的（结算通知在案）不算——主会话知道结果了，再续就是重做。
 * 外部后端（Codex/Claude Code/ACP）没有本地会话日志，续不了，交给主会话重新委派。
 */
async function pendingChildRows(hosts, parentId, parentEvents, options, budget) {
    const rows = [];
    const notes = [];
    // 已经向主会话报告过的子会话（结算通知在案）不算「还在等」——主会话知道结果了，
    // 把它叫醒是多余的（2026-11-09 现场：正常结束的会话被子会话的失败通知拖去重跑）。
    const reported = reportedChildIds(parentEvents);
    // 目录按创建顺序追加，**新的在后面**：被中断的通常是最新的那个，所以倒着看，
    // 观察预算有限时先看它。
    const children = [...catalogChildren(parentEvents)].reverse();
    for (const child of children) {
        if (budget.left <= 0)
            break;
        if (reported.has(child.childId)) {
            notes.push({ childId: child.childId, detail: '已经向主会话报告过（结算通知在案）' });
            continue;
        }
        if (!hasLocalSession(child)) {
            notes.push({ childId: child.childId, detail: '外部后端子会话，没有本地会话日志' });
            continue;
        }
        budget.left -= 1;
        const observed = await observeTimed(hosts, child.childId);
        if (!observed.ok) {
            notes.push({ childId: child.childId, detail: observed.detail });
            continue;
        }
        try {
            const verdict = classifySession(observed.observation.events, options);
            if (verdict.action === 'continue') {
                rows.push({
                    sessionId: child.childId,
                    action: 'continue',
                    cause: verdict.cause,
                    lastTime: verdict.lastTime,
                    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
                    parentSessionId: parentId,
                });
            }
        }
        finally {
            observed.observation[Symbol.dispose]?.();
        }
    }
    return { rows, notes };
}
/** 快速通道：fs 直查候选 → 运行中/归档过滤 → 带超时观察判定。 */
async function scanViaRecent(hosts, options, recent, progress) {
    const candidates = await recent.listRecent(options.lookbackHours, options.maxObservations, options.now);
    progress?.(0, candidates.length);
    const archived = new Set(hosts.workspaceRegistry.archivedSessionIds);
    const rows = [];
    const budget = { left: options.maxChildObservations };
    let scanned = 0;
    for (const candidate of candidates) {
        scanned += 1;
        const live = hosts.agents.get(candidate.sessionId);
        if (live?.status === 'running') {
            rows.push({ sessionId: candidate.sessionId, action: 'skip', cause: 'running', lastTime: 0 });
            progress?.(scanned, candidates.length);
            continue;
        }
        if (archived.has(candidate.sessionId)) {
            rows.push({ sessionId: candidate.sessionId, action: 'skip', cause: 'archived', lastTime: 0 });
            progress?.(scanned, candidates.length);
            continue;
        }
        rows.push(...(await judgeCandidate(hosts, candidate.sessionId, options, budget)));
        progress?.(scanned, candidates.length);
    }
    return rows;
}

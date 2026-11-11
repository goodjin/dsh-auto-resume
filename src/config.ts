/**
 * 配置解析与继续消息模板。
 *
 * 挂载行 config 经宿主 Config schema 校验后进 apply；这里再做一层防御性解析
 * （缺省补默认、负数取 0），让扫描编排拿到的值永远完整可用——宿主各版本的
 * schema 默认值行为不完全一致，插件自己兜底最稳。
 *
 * @module @goodjin2/dsh-auto-resume/config
 */

import Schema from '@deepseek-ai/schemastery'

/** 挂载行 config 的声明形状（宿主校验用，字段全部可选）。 */
export interface AutoResumeConfig {
  enabled?: boolean
  lookbackHours?: number
  startupDelayMs?: number
  staggerMs?: number
  includeError?: boolean
  includeDisposed?: boolean
  maxObservations?: number
  /** 是否恢复被中断的子会话（经父会话的子代理路由正门）。 */
  resumeChildren?: boolean
  /** 判定阶段最多读多少个子会话日志。 */
  maxChildObservations?: number
  /** 一次启动最多恢复多少个子会话。 */
  maxChildResumes?: number
  /** 暂时性失败（网络 / 限速 / 超时）的会话按这个周期重试；0 = 不周期重试。 */
  retryIntervalMs?: number
  /** 连续失败到这个数就放弃并标记不再重试。 */
  maxRetries?: number
  messageTemplate?: string
  /** 给子会话的继续消息模板（{parent}/{reason}/{time} 占位符）。 */
  childMessageTemplate?: string
}

/** 解析完成后扫描编排实际消费的形状（字段全部必有）。 */
export interface ResolvedConfig {
  enabled: boolean
  lookbackHours: number
  startupDelayMs: number
  staggerMs: number
  includeError: boolean
  includeDisposed: boolean
  maxObservations: number
  resumeChildren: boolean
  maxChildObservations: number
  maxChildResumes: number
  retryIntervalMs: number
  maxRetries: number
  messageTemplate: string
  childMessageTemplate: string
}

/** 继续消息默认模板：{reason} 换人话原因，{time} 换本地时间。 */
export const DEFAULT_MESSAGE_TEMPLATE = [
  '【自动恢复】检测到本会话上次因异常中断而停止（原因：{reason}，时间：{time}）。',
  '请从中断处继续完成任务。如果任务其实已完成或已不再需要，请简要说明现状后结束，不要重新开始已做完的工作。',
].join('\n')

/** 给子会话的默认继续消息：{parent} 换父会话 id，{reason}/{time} 同父会话模板。 */
export const DEFAULT_CHILD_MESSAGE_TEMPLATE = [
  '【自动恢复】你在父会话 {parent} 的委派中途被中断（原因：{reason}，时间：{time}）。',
  '请从中断处继续完成原任务。如果任务其实已完成或已不再需要，请简要说明现状后结束，不要重新开始已做完的工作。',
].join('\n')

/** 挂载行 config 的宿主 schema（check-host-rows 用它校验行的 config）。 */
export const Config: Schema<AutoResumeConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  lookbackHours: Schema.number().default(24),
  startupDelayMs: Schema.number().default(8000),
  staggerMs: Schema.number().default(2000),
  includeError: Schema.boolean().default(true),
  includeDisposed: Schema.boolean().default(true),
  maxObservations: Schema.number().default(30),
  resumeChildren: Schema.boolean().default(true),
  maxChildObservations: Schema.number().default(20),
  maxChildResumes: Schema.number().default(10),
  retryIntervalMs: Schema.number().default(600_000),
  maxRetries: Schema.number().default(3),
  messageTemplate: Schema.string().default(DEFAULT_MESSAGE_TEMPLATE),
  childMessageTemplate: Schema.string().default(DEFAULT_CHILD_MESSAGE_TEMPLATE),
})

/** 数值钳位：非数值回默认，负数取 0（窗口与延时不存在负值语义）。 */
function nonNegative(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return value < 0 ? 0 : value
}

/** 布尔值：非布尔一律回默认。 */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 把挂载行来的任意 config 解析成完整配置：缺省补默认、负数取 0、
 * 模板缺失回默认模板。
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as AutoResumeConfig
  return {
    enabled: booleanOr(source.enabled, true),
    lookbackHours: nonNegative(source.lookbackHours, 24),
    startupDelayMs: nonNegative(source.startupDelayMs, 8000),
    staggerMs: nonNegative(source.staggerMs, 2000),
    includeError: booleanOr(source.includeError, true),
    includeDisposed: booleanOr(source.includeDisposed, true),
    maxObservations: nonNegative(source.maxObservations, 30),
    resumeChildren: booleanOr(source.resumeChildren, true),
    maxChildObservations: nonNegative(source.maxChildObservations, 20),
    maxChildResumes: nonNegative(source.maxChildResumes, 10),
    retryIntervalMs: nonNegative(source.retryIntervalMs, 600_000),
    maxRetries: nonNegative(source.maxRetries, 3),
    messageTemplate:
      typeof source.messageTemplate === 'string' && source.messageTemplate.trim() !== ''
        ? source.messageTemplate
        : DEFAULT_MESSAGE_TEMPLATE,
    childMessageTemplate:
      typeof source.childMessageTemplate === 'string' && source.childMessageTemplate.trim() !== ''
        ? source.childMessageTemplate
        : DEFAULT_CHILD_MESSAGE_TEMPLATE,
  }
}

/**
 * 渲染继续消息：替换模板里全部 `{reason}` 与 `{time}` 出现。
 * 用 split/join 而不是 replace 正则，避免模板里的特殊字符被当正则解读。
 */
export function renderMessage(template: string, reason: string, time: string): string {
  return template.split('{reason}').join(reason).split('{time}').join(time)
}

/**
 * The private Host Skills standing-read and invalidation contracts. Both
 * descriptors are shared by the ONE Host and Client contribution.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/remote/pi-tui-skills-contract
 */

import type {
  InvocationDescriptor,
  RemoteResult,
  RemoteStreamHandle,
  TypertCodec,
} from '@deepseek-ai/dsh-typert-protocol'

export const PI_TUI_SKILLS_NAMESPACE = 'piTuiSkills'
export const PI_TUI_SKILLS_STANDING_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiSkills/standing'
export const PI_TUI_SKILLS_WATCH_INVALIDATIONS_ENDPOINT = '@xmoon76/dsh-pi-tui#piTuiSkills/watchInvalidations'

export interface PiTuiSkillsStandingRequest {
  readonly presetId?: string
  readonly workspaceId: string
}

export interface PiTuiStandingSkillSummary {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
}

export interface PiTuiSkillsStandingResult {
  readonly skills: readonly PiTuiStandingSkillSummary[]
  readonly complete: boolean
  readonly notice?: string
}

export interface PiTuiSkillsInvalidationFrame {
  readonly kind: 'invalidated'
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: the value must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new TypeError(`${label}: unexpected field ${JSON.stringify(key)}`)
  }
}

export function parsePiTuiSkillsStandingRequest(value: unknown): PiTuiSkillsStandingRequest {
  const record = recordOf(value, 'piTuiSkills/standing request')
  assertOnlyKeys(record, ['workspaceId', 'presetId'], 'piTuiSkills/standing request')
  if (typeof record.workspaceId !== 'string' || record.workspaceId === '') {
    throw new TypeError('piTuiSkills/standing request: workspaceId must be a non-empty string')
  }
  if (record.presetId !== undefined && (typeof record.presetId !== 'string' || record.presetId === '')) {
    throw new TypeError('piTuiSkills/standing request: presetId must be a non-empty string when supplied')
  }
  return {
    workspaceId: record.workspaceId,
    ...(typeof record.presetId === 'string' ? { presetId: record.presetId } : {}),
  }
}

export function parsePiTuiSkillsStandingResult(value: unknown): PiTuiSkillsStandingResult {
  const record = recordOf(value, 'piTuiSkills/standing result')
  assertOnlyKeys(record, ['skills', 'complete', 'notice'], 'piTuiSkills/standing result')
  if (!Array.isArray(record.skills) || typeof record.complete !== 'boolean') {
    throw new TypeError('piTuiSkills/standing result: skills and complete are required')
  }
  if (record.notice !== undefined && typeof record.notice !== 'string') {
    throw new TypeError('piTuiSkills/standing result: notice must be a string when supplied')
  }
  const skills = record.skills.map((value): PiTuiStandingSkillSummary => {
    const skill = recordOf(value, 'piTuiSkills/standing skill')
    assertOnlyKeys(skill, ['name', 'description', 'whenToUse', 'modelInvocable'], 'piTuiSkills/standing skill')
    if (typeof skill.name !== 'string' || skill.name === ''
      || typeof skill.description !== 'string'
      || typeof skill.modelInvocable !== 'boolean'
      || (skill.whenToUse !== undefined && typeof skill.whenToUse !== 'string')) {
      throw new TypeError('piTuiSkills/standing skill: malformed detached skill metadata')
    }
    return {
      name: skill.name,
      description: skill.description,
      ...(typeof skill.whenToUse === 'string' ? { whenToUse: skill.whenToUse } : {}),
      modelInvocable: skill.modelInvocable,
    }
  })
  return {
    skills,
    complete: record.complete,
    ...(typeof record.notice === 'string' ? { notice: record.notice } : {}),
  }
}

export function parsePiTuiSkillsInvalidationFrame(value: unknown): PiTuiSkillsInvalidationFrame {
  const record = recordOf(value, 'piTuiSkills/watchInvalidations frame')
  assertOnlyKeys(record, ['kind'], 'piTuiSkills/watchInvalidations frame')
  if (record.kind !== 'invalidated') {
    throw new TypeError('piTuiSkills/watchInvalidations frame: kind must be invalidated')
  }
  return { kind: 'invalidated' }
}

const REQUEST_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SKILLS_STANDING_ENDPOINT}:request`,
  create: () => ({ parse: parsePiTuiSkillsStandingRequest }),
}

const STANDING_RESULT_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SKILLS_STANDING_ENDPOINT}:result`,
  create: () => ({ parse: parsePiTuiSkillsStandingResult }),
  decode: parsePiTuiSkillsStandingResult,
}

const INVALIDATION_FRAME_CODEC: TypertCodec = {
  mode: 'strict',
  typeSymbol: `${PI_TUI_SKILLS_WATCH_INVALIDATIONS_ENDPOINT}:frame`,
  create: () => ({ parse: parsePiTuiSkillsInvalidationFrame }),
  decode: parsePiTuiSkillsInvalidationFrame,
}

export const PI_TUI_SKILLS_STANDING: InvocationDescriptor = {
  id: PI_TUI_SKILLS_STANDING_ENDPOINT,
  service: PI_TUI_SKILLS_NAMESPACE,
  namespace: PI_TUI_SKILLS_NAMESPACE,
  method: 'standing',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json',
    codec: REQUEST_CODEC,
  }],
  cancellation: { parameter: 'signal' },
  result: STANDING_RESULT_CODEC,
}

export const PI_TUI_SKILLS_WATCH_INVALIDATIONS: InvocationDescriptor = {
  id: PI_TUI_SKILLS_WATCH_INVALIDATIONS_ENDPOINT,
  service: PI_TUI_SKILLS_NAMESPACE,
  namespace: PI_TUI_SKILLS_NAMESPACE,
  method: 'watchInvalidations',
  mode: 'stream',
  invocation: { kind: 'direct' },
  parameters: [],
  cancellation: { parameter: 'signal' },
  result: INVALIDATION_FRAME_CODEC,
}

export type PiTuiSkillsStandingCall = RemoteResult<PiTuiSkillsStandingResult>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteMap {
    'piTuiSkills/standing': (
      request: PiTuiSkillsStandingRequest,
      signal?: AbortSignal,
    ) => Promise<PiTuiSkillsStandingCall>
    'piTuiSkills/watchInvalidations': (
      signal?: AbortSignal,
    ) => RemoteStreamHandle<PiTuiSkillsInvalidationFrame, never>
  }

  interface TypertRemoteNamespaceMap {
    'piTuiSkills': {
      standing: (
        request: PiTuiSkillsStandingRequest,
        signal?: AbortSignal,
      ) => Promise<PiTuiSkillsStandingCall>
      watchInvalidations: (
        signal?: AbortSignal,
      ) => RemoteStreamHandle<PiTuiSkillsInvalidationFrame, never>
    }
  }
}

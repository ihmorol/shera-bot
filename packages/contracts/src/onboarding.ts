/**
 * Onboarding contracts (S30, issue #31; D16, E43).
 *
 * D16: zero-config start is the default — the product works immediately with
 * safe defaults; the onboarding is an ordered, skippable, reopenable
 * sequence whose every step KEEPS the recommended default, and onboarding
 * and settings use the SAME commands and schemas (the memory briefing's
 * auto-memory choice issues the memory.set_auto_memory contract command;
 * the provider check reads the same registry rows the Providers settings
 * surface renders).
 *
 * E43: the interview is a chat card with typed A/B/C/D choice chips plus a
 * free-text answer — the options are DATA the runtime validates, never
 * prompt text the runtime interprets. No credential field exists anywhere:
 * the provider check only ever READS the deployment default (D16/D17/G4).
 */
import { z } from "zod";

import { Actor, Id, IsoDateTime, WorkspaceId } from "./primitives.ts";

/** The recorded D16 step order. */
export const ONBOARDING_STEPS = [
  "welcome",
  "provider_check",
  "approvals_briefing",
  "memory_briefing",
  "done",
] as const;
export const OnboardingStepId = z.enum(ONBOARDING_STEPS);
export type OnboardingStepId = z.infer<typeof OnboardingStepId>;

/** One typed choice chip: an option id the runtime validates, a label, a
 * one-line description. Free text is optional per step. */
export const OnboardingOption = z.strictObject({
  option_id: z.string().min(1).max(64),
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(300),
});
export type OnboardingOption = z.infer<typeof OnboardingOption>;

/**
 * The per-step typed vocabulary. `answer` records what the user chose (the
 * option id, and the free text where the step accepts it). `effective_state`
 * carries the runtime's OWN record the step reads (e.g. the memory step
 * reflects the current auto-memory setting; the provider step the
 * deployment default) — never a stale local copy.
 */
export const OnboardingStepView = z.strictObject({
  step: OnboardingStepId,
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(600),
  question: z.string().min(1).max(300).nullable(),
  options: z.array(OnboardingOption).max(8),
  accepts_free_text: z.boolean(),
  free_text_placeholder: z.string().min(1).max(200).nullable(),
  answer: z
    .strictObject({
      option_id: z.string().min(1).max(64).nullable(),
      free_text: z.string().min(1).max(500).nullable(),
      answered_at: IsoDateTime,
    })
    .nullable(),
});
export type OnboardingStepView = z.infer<typeof OnboardingStepView>;

/** The deployment default the provider check reads (the registry's rows). */
export const OnboardingProviderSummary = z.strictObject({
  configured: z.boolean(),
  provider_id: Id.nullable(),
  model: z.string().min(1).max(256).nullable(),
});
export type OnboardingProviderSummary = z.infer<typeof OnboardingProviderSummary>;

export const OnboardingStatus = z.enum(["pending", "completed", "dismissed"]);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;

/** One recorded answer: the typed option id and/or the free text, with when. */
export const OnboardingAnswerRecord = z.strictObject({
  option_id: z.string().min(1).max(64).nullable(),
  free_text: z.string().min(1).max(500).nullable(),
  answered_at: IsoDateTime,
});
export type OnboardingAnswerRecord = z.infer<typeof OnboardingAnswerRecord>;

export const OnboardingSnapshot = z.strictObject({
  workspace_id: WorkspaceId,
  status: OnboardingStatus,
  current_step: OnboardingStepId.nullable(),
  steps: z.array(OnboardingStepView).max(8),
  provider_summary: OnboardingProviderSummary.nullable(),
  answers: z.record(z.string().min(1).max(64), OnboardingAnswerRecord),
});
export type OnboardingSnapshot = z.infer<typeof OnboardingSnapshot>;

/**
 * The typed onboarding commands. `onboarding.answer` validates the option id
 * against the step's declared set (G2: answers are data, the runtime refuses
 * anything else) and runs the step's recorded effect — for the memory
 * briefing that is the memory.set_auto_memory contract command (D16: the
 SAME commands and schemas as settings).
 */
export const OnboardingCommand = z.discriminatedUnion("type", [
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("onboarding.answer"),
    step: OnboardingStepId,
    option_id: z.string().min(1).max(64),
    free_text: z.string().min(1).max(500).nullable(),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("onboarding.dismiss"),
  }),
  z.strictObject({
    command_id: Id,
    idempotency_key: Id,
    workspace_id: WorkspaceId,
    actor: Actor,
    issued_at: IsoDateTime,
    type: z.literal("onboarding.reopen"),
  }),
]);
export type OnboardingCommand = z.infer<typeof OnboardingCommand>;
export type OnboardingAnswerCommand = Extract<OnboardingCommand, { type: "onboarding.answer" }>;

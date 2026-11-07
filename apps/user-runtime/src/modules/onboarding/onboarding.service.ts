/**
 * S30 — the D16 onboarding state machine (issue #31; D16, E43, G2/G4/G6).
 *
 * Zero-config start is the default: an absent state row IS the fresh
 * account — status pending, every recommended default already active, the
 * product works immediately. The interview is ORDERED, SKIPPABLE,
 * REOPENABLE, RESUMABLE; every step keeps the recommended default and the
 * answers are DATA (typed option ids the runtime validates, plus optional
 * free text — never prose the runtime interprets, G2).
 *
 * D16's shared-schema rule is structural here: the ONLY step that changes
 * configuration (the memory briefing's auto-memory choice) issues the SAME
 * memory.set_auto_memory contract command the Memory settings surface uses,
 * through the memory service's own command path — a change made in
 * onboarding is visible in settings and vice versa. The provider check
 * READS the providers registry's rows (the deployment default) and offers
 * no credential field — a missing provider renders the honest configuration
 * state (D17/G4), never an invented default.
 */
import {
  ONBOARDING_STEPS,
  OnboardingCommand,
  type OnboardingAnswerRecord,
  type OnboardingProviderSummary,
  type OnboardingSnapshot,
  type OnboardingStepView,
} from "@shera-bot/contracts";

import type { OnboardingRepository } from "../../adapters/sqlite/onboarding-repository.ts";
import type { CommandReceiptsRepository } from "../../adapters/sqlite/command-receipts-repository.ts";
import type { SqliteTransactions } from "../../adapters/sqlite/transactions.ts";
import type { MemoryService } from "../memory/memory.service.ts";
import type { ProviderService } from "../providers/provider-service.ts";

export class OnboardingServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly category: string,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "OnboardingServiceError";
  }
}

/** The typed choice chips per step (E43: options are data). */
const STEP_OPTIONS: Record<string, Array<{ option_id: string; label: string; description: string }>> = {
  welcome: [
    { option_id: "research", label: "Research", description: "Papers, sources, citations, summaries." },
    { option_id: "programming", label: "Programming", description: "Assignments, code review, debugging." },
    { option_id: "exam_prep", label: "Exam preparation", description: "Study plans, practice questions, recaps." },
    { option_id: "something_else", label: "Something else", description: "Tell us in your own words below." },
  ],
  provider_check: [
    {
      option_id: "keep_default",
      label: "Keep the deployment default",
      description: "You can change the provider or model anytime in Settings.",
    },
  ],
  approvals_briefing: [
    {
      option_id: "got_it",
      label: "Got it",
      description: "You'll see exactly what pauses before anything risky runs.",
    },
  ],
  memory_briefing: [
    {
      option_id: "memory_auto_on",
      label: "Keep auto-memory on",
      description: "Agents remember what you allow; you can always inspect or forget.",
    },
    {
      option_id: "memory_auto_off",
      label: "Turn auto-memory off",
      description: "Nothing is remembered automatically; you can re-enable it in Settings.",
    },
  ],
  done: [
    {
      option_id: "finish",
      label: "Finish",
      description: "Open your workspace — the defaults keep working either way.",
    },
  ],
};

const STEP_QUESTIONS: Record<string, string | null> = {
  welcome: "What do you mostly want help with? Pick whatever's closest — we can always expand from there.",
  provider_check: null,
  approvals_briefing: "Ready to see what pauses?",
  memory_briefing: "Should agents remember things automatically?",
  done: null,
};

const STEP_FREE_TEXT: Record<string, { accepts: boolean; placeholder: string | null }> = {
  welcome: { accepts: true, placeholder: "Tell us in your own words…" },
  provider_check: { accepts: false, placeholder: null },
  approvals_briefing: { accepts: false, placeholder: null },
  memory_briefing: { accepts: false, placeholder: null },
  done: { accepts: false, placeholder: null },
};

function nextStep(after: string): string | null {
  const index = ONBOARDING_STEPS.indexOf(after as (typeof ONBOARDING_STEPS)[number]);
  if (index < 0 || index === ONBOARDING_STEPS.length - 1) {
    return null;
  }
  return ONBOARDING_STEPS[index + 1]!;
}

export interface OnboardingServiceDeps {
  onboarding: OnboardingRepository;
  memory: MemoryService;
  providers: ProviderService;
  receipts: CommandReceiptsRepository;
  tx: SqliteTransactions;
  /** The container's workspace (E12). */
  workspaceId: string;
  now?: () => string;
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  private nowIso(): string {
    return this.deps.now ? this.deps.now() : new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Snapshot (the read model)
  // -------------------------------------------------------------------------

  snapshot(workspaceId: string): OnboardingSnapshot {
    const row = this.deps.onboarding.get(workspaceId);
    const answers = this.parseAnswers(row?.answers_json ?? "{}");
    const status = row?.status ?? "pending";
    const currentStep = this.currentStepOf(status, row?.current_step ?? null, answers);

    const providerSummary = this.providerSummary(workspaceId);
    const memoryOn = this.deps.memory.userView(workspaceId).auto_memory.global_enabled;

    const steps: OnboardingStepView[] = ONBOARDING_STEPS.map((step) => {
      const answer = answers[step] ?? null;
      const base: OnboardingStepView = {
        step,
        title:
          step === "memory_briefing"
            ? `Memory briefing — Auto-memory is ${memoryOn ? "on" : "off"}`
            : step === "welcome"
              ? "Welcome to Shera"
              : step === "provider_check"
                ? "Provider and model"
                : step === "approvals_briefing"
                  ? "What pauses for your approval"
                  : "You're set",
        body: this.stepBody(step, memoryOn),
        question: STEP_QUESTIONS[step] ?? null,
        options: STEP_OPTIONS[step] ?? [],
        accepts_free_text: STEP_FREE_TEXT[step]?.accepts ?? false,
        free_text_placeholder: STEP_FREE_TEXT[step]?.placeholder ?? null,
        answer,
      };
      return base;
    });

    return {
      workspace_id: workspaceId,
      status,
      current_step: currentStep,
      steps,
      provider_summary: providerSummary,
      answers: answers,
    };
  }

  private stepBody(step: string, memoryOn: boolean): string {
    switch (step) {
      case "welcome":
        return "Shera works right away with safe defaults — nothing here blocks you. Answer what you like, skip the rest.";
      case "provider_check":
        return "Shera uses the deployment's default provider and model for new conversations. You can change this anytime in Settings → Providers & models — no credentials are asked for or stored here.";
      case "approvals_briefing":
        return "Risky actions pause for your approval: file changes outside the workspace, external writes, deployments. Read-only work runs automatically; you see the five choices on every pause.";
      case "memory_briefing":
        return memoryOn
          ? "Agents can remember useful facts automatically. Everything is inspectable, editable, and forgettable in Settings → Memory — and secrets are never stored."
          : "Auto-memory is off: nothing is remembered automatically. You can re-enable it in Settings → Memory at any time.";
      default:
        return "Your answers are saved and the recommended defaults stayed active throughout. You can reopen this interview anytime from Settings → Account.";
    }
  }

  /** The deployment default from the registry's own rows (never invented). */
  private providerSummary(workspaceId: string): OnboardingProviderSummary {
    const providers = this.deps.providers.listProviders(workspaceId);
    const active = providers.find((provider) => provider.status === "enabled");
    if (!active) {
      return { configured: false, provider_id: null, model: null };
    }
    return {
      configured: true,
      provider_id: active.id,
      model: active.default_model_id,
    };
  }

  private parseAnswers(json: string): Record<string, OnboardingAnswerRecord> {
    try {
      const parsed: unknown = JSON.parse(json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, OnboardingAnswerRecord>;
      }
    } catch {
      // Corrupt JSON falls back to no answers — the state stays resumable.
    }
    return {};
  }

  /** Resume point: the first unanswered step (a dismissed run resumes there). */
  private currentStepOf(
    status: OnboardingSnapshot["status"],
    stored: string | null,
    answers: Record<string, OnboardingAnswerRecord>,
  ): OnboardingSnapshot["current_step"] {
    if (status !== "pending") {
      return null;
    }
    const firstUnanswered = ONBOARDING_STEPS.find((step) => !answers[step]);
    if (firstUnanswered) {
      return firstUnanswered;
    }
    return stored && ONBOARDING_STEPS.includes(stored as (typeof ONBOARDING_STEPS)[number])
      ? (stored as OnboardingSnapshot["current_step"])
      : "done";
  }

  // -------------------------------------------------------------------------
  // Commands (G2: typed, receipted; the actor is the session-bound user)
  // -------------------------------------------------------------------------

  submitCommand(workspaceId: string, command: unknown): { accepted: true } {
    const parsed = OnboardingCommand.safeParse(command);
    if (!parsed.success) {
      throw new OnboardingServiceError(
        "ONBOARDING_COMMAND_INVALID",
        "validation",
        "The onboarding command is not valid: the body must be an onboarding command whose workspace_id matches the path.",
      );
    }
    const typed = parsed.data;
    if (typed.workspace_id !== workspaceId) {
      throw new OnboardingServiceError(
        "ONBOARDING_WORKSPACE_MISMATCH",
        "validation",
        "The onboarding command's workspace does not match the request.",
        403,
      );
    }
    const existing = this.deps.receipts.findById(workspaceId, typed.idempotency_key);
    if (existing) {
      return { accepted: true };
    }

    const now = this.nowIso();
    this.deps.tx.transaction((exec) => {
      const row = this.deps.onboarding.get(workspaceId, exec);
      const answers = this.parseAnswers(row?.answers_json ?? "{}");
      const status = row?.status ?? "pending";

      if (typed.type === "onboarding.dismiss") {
        // Skippable (D16): the progress is preserved for the reopen.
        this.deps.onboarding.put(
          workspaceId,
          { status: "dismissed", current_step: null, answers_json: JSON.stringify(answers) },
          now,
          exec,
        );
      } else if (typed.type === "onboarding.reopen") {
        // Reopenable (D16): pending again, resuming at the first unanswered step.
        const resume = this.currentStepOf("pending", null, answers);
        this.deps.onboarding.put(
          workspaceId,
          {
            status: "pending",
            current_step: resume,
            answers_json: JSON.stringify(answers),
          },
          now,
          exec,
        );
      } else {
        // onboarding.answer — the ordered interview: only the CURRENT step
        // accepts an answer, and only one of ITS declared options (G2: the
        // options are data, the runtime refuses anything else).
        if (status !== "pending") {
          throw new OnboardingServiceError(
            "ONBOARDING_NOT_ACTIVE",
            "state",
            "The onboarding is not active — reopen it first.",
            409,
          );
        }
        const current = this.currentStepOf("pending", row?.current_step ?? null, answers);
        if (current !== typed.step) {
          throw new OnboardingServiceError(
            "ONBOARDING_STEP_OUT_OF_ORDER",
            "validation",
            `The onboarding is ordered — ${typed.step} is not the current step.`,
          );
        }
        const option = (STEP_OPTIONS[typed.step] ?? []).find(
          (candidate) => candidate.option_id === typed.option_id,
        );
        if (!option) {
          throw new OnboardingServiceError(
            "ONBOARDING_OPTION_INVALID",
            "validation",
            "That choice is not one of this step's options.",
          );
        }

        // The step's recorded effect rides the SHARED settings command
        // surface (D16): the memory briefing's choice IS the
        // memory.set_auto_memory contract command, applied through the
        // memory service's own command path with the SAME actor. The derived
        // idempotency key keeps the TWO receipts (onboarding + memory)
        // distinct while staying deterministic: a replayed onboarding key
        // re-derives the same memory key, whose receipt answers first.
        if (typed.step === "memory_briefing") {
          void this.deps.memory
            .applyCommand({
              command_id: `${typed.command_id}-memory`,
              idempotency_key: `${typed.idempotency_key}-memory`,
              workspace_id: workspaceId,
              actor: typed.actor,
              issued_at: typed.issued_at,
              type: "memory.set_auto_memory",
              enabled: typed.option_id === "memory_auto_on",
            })
            .catch(() => {
              // The memory command validates typed — a refusal here is the
              // shared surface's own typed answer, surfaced on the next read.
            });
        }

        const nextAnswers: Record<string, OnboardingAnswerRecord> = {
          ...answers,
          [typed.step]: {
            option_id: typed.option_id,
            free_text: typed.free_text,
            answered_at: now,
          },
        };
        const completed = typed.step === "done";
        this.deps.onboarding.put(
          workspaceId,
          {
            status: completed ? "completed" : "pending",
            current_step: completed ? null : nextStep(typed.step),
            answers_json: JSON.stringify(nextAnswers),
          },
          now,
          exec,
        );
      }

      this.deps.receipts.create(
        {
          workspace_id: workspaceId,
          idempotency_key: typed.idempotency_key,
          command_type: typed.type,
          result_json: JSON.stringify({ accepted: true }),
          created_at: now,
        },
        exec,
      );
    });

    return { accepted: true };
  }
}

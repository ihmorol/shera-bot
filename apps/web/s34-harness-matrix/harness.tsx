import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import "../app/globals.css";

/**
 * The S34 browser-matrix harness (the recorded S24-harness pattern): the REAL
 * shipped web components over FROZEN fixture state — hermetic, deterministic,
 * no server (E43 tier-1/tier-2 posture). It is surface QA: what the shipped
 * components render and how they behave in real §18 browsers. It never
 * vouches for live runtime behavior; the ledger keeps those evidence kinds
 * separate on purpose (E14).
 *
 * Named surfaces (the axe-core + layout matrix scope):
 *   login | operation-chat | approval | providers-settings | providers-failure | credits-settings
 */

// The real production entry surface.
import LoginPage from "@/app/login/page";

// The real chat thread pieces (§S3).
import { ApprovalCard, ApprovalDecisionModal } from "@/components/chat/approval-card";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { StreamingMessage } from "@/components/chat/streaming-message";

// The real settings surfaces (§S9).
import { CreditsSettingsView } from "@/components/settings/credits-settings";
import { ProvidersSettingsView } from "@/components/settings/providers-settings";

// Frozen fixture data the shipped surfaces consume.
import type { ProviderView } from "@shera-bot/contracts";

import type { AgentRosterSummary } from "@/lib/agent-api";
import {
  APPROVAL_CHOICE_LABELS,
  APPROVAL_CHOICE_ORDER,
  type ApprovalCardData,
} from "@/lib/approvals-api";
import { buildThread, type ChatMessage, type ThreadItem } from "@/lib/fixtures";
import { insertDaySeparators } from "@/lib/thread-layout";

// ---------------------------------------------------------------------------
// Frozen fixtures (pure data — the E43 tier-1 rule; no server, no runtime)
// ---------------------------------------------------------------------------

const TUTOR_THREAD = insertDaySeparators(buildThread("conversation_agent_programming_tutor"));
const RESEARCH_PAPER_THREAD = insertDaySeparators(buildThread("conversation_op_research_paper"));

const APPROVAL_FIXTURE: ApprovalCardData = {
  approval_id: "apr_s34_matrix",
  workspace_id: "ws_default_01",
  task_id: "task_run_tutor_backup",
  conversation_id: "conversation_agent_programming_tutor",
  tool_id: "tool_repo_push",
  tool_version: "0.9.2",
  capability: "repository.push",
  risk_class: "EXTERNAL_WRITE",
  resource_scope: "workspace://repo/assignment-2 branch: solution",
  args_digest: `sha256:${"b".repeat(64)}`,
  side_effect_summary: "Push 2 commits to the remote branch.",
  requested_by: { type: "agent", id: "agent_programming_tutor" },
  requested_at: "2026-09-20T13:58:00Z",
  status: "pending",
  expires_at: "2026-09-20T14:58:00Z",
};

const REMINDER_FIXTURE = [0, 1, 2, 3, 4].map((reminder_index) => ({
  reminder_index,
  // Real date arithmetic: minute overflow (58+2 = "60") would be an invalid
  // time value and crash the card's formatter — the fixture must be honest
  // ISO end to end.
  due_at: new Date(Date.parse("2026-09-20T13:58:00Z") + reminder_index * 15 * 60_000).toISOString(),
  delivered_at: reminder_index === 0 ? "2026-09-20T13:58:05Z" : null,
}));

const IDENTITIES: AgentRosterSummary[] = [
  {
    agent_id: "agent_programming_tutor",
    display_name: "Programming Tutor",
    role_description: "Coaching-first coding help",
    avatar_hue: 210,
    initial_glyph: "PT",
    has_user_instructions: true,
    session: { presence: "active" },
  },
];

const OLLAMA_PROVIDER: ProviderView = {
  id: "prov_s34_local",
  workspace_id: "ws_default_01",
  display_name: "Local Ollama",
  protocol: "ollama",
  base_url: "http://127.0.0.1:11434/v1",
  api_mode: "no_key",
  default_model_id: "llama3.1:8b",
  organization: null,
  project: null,
  headers: {},
  request_params: {},
  origin: "user",
  status: "enabled",
  credential_hint: null,
  created_at: "2026-10-30T10:00:00.000Z",
  updated_at: "2026-10-30T10:00:00.000Z",
};

const CREDITS_SUMMARY = {
  workspace_id: "ws_default_01",
  account: {
    granted_units: 200,
    charged_units: 50,
    reserved_units: 25,
    remaining_units: 150,
    used_this_month_units: 50,
    exhausted: false,
  },
  custom_provider_usage: {
    calls: 2,
    input_tokens: 12400,
    output_tokens: 3180,
    providers: ["prov_s34_local"],
  },
  recent_runs: [
    {
      task_id: "run_s34_matrix",
      charged_units: 30,
      released_units: 20,
      active_reserved_units: 0,
      last_movement_at: "2026-11-08T09:01:00.000Z",
    },
  ],
};

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** The §S3 chat surface: real thread + streaming slot + real composer. */
function OperationChatSurface() {
  const [extraItems, setExtraItems] = useState(TUTOR_THREAD);
  return (
    <section data-surface="operation-chat" className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      <header className="border-b border-line px-6 py-4">
        <h1 className="font-display text-lg font-semibold text-text">Programming Tutor</h1>
      </header>
      <div className="flex-1">
        <MessageList items={extraItems} jumpTargetId={null} unreadCount={0} />
        <StreamingMessage
          agentId="agent_programming_tutor"
          visibleText="Streaming the demo fixture burst — one delta per frame."
          announcementText="Streaming the demo fixture burst"
          done={false}
          stopped={false}
          onStop={() => undefined}
        />
      </div>
      <footer className="border-t border-line px-6 py-4">
        <Composer
          agentName="Programming Tutor"
          onSend={(text) => {
            // The composer is the real component; the harness records the
            // send locally (fixture state) so a real browser click proves
            // the interactive wiring without any runtime.
            const message: ChatMessage = {
              message_id: `msg_s34_local_${extraItems.length}`,
              conversation_id: "conversation_agent_programming_tutor",
              sender: { kind: "user", display_name: "Emon" },
              sent_at: new Date().toISOString(),
              text,
              delivery: "sent",
              delivery_class: "live",
            };
            const item: ThreadItem = { kind: "message", at: message.sent_at, message };
            setExtraItems([...extraItems, item]);
          }}
        />
      </footer>
    </section>
  );
}

/**
 * The Operation thread with its artifact/run cards visible (the §S4 result
 * leg): real thread components over the research-paper operation fixtures.
 */
function OperationArtifactsSurface() {
  return (
    <section
      data-surface="operation-thread-artifacts"
      className="mx-auto flex min-h-dvh max-w-3xl flex-col"
    >
      <header className="border-b border-line px-6 py-4">
        <h1 className="font-display text-lg font-semibold text-text">Research paper</h1>
      </header>
      <MessageList items={RESEARCH_PAPER_THREAD} jumpTargetId={null} unreadCount={0} />
    </section>
  );
}

/** The approval centerpiece (§S8): the real card + the real decision modal. */
function ApprovalSurface() {
  const [modalOpen, setModalOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  return (
    <section data-surface="approval" className="mx-auto max-w-2xl px-6 py-8">
      <ApprovalCard
        approval={APPROVAL_FIXTURE}
        identities={IDENTITIES}
        reminders={REMINDER_FIXTURE}
        onReview={() => setModalOpen(true)}
        onMute={() => undefined}
        reviewPending={false}
        mutePending={false}
      />
      <ApprovalDecisionModal
        approval={APPROVAL_FIXTURE}
        identities={IDENTITIES}
        run={{ task_id: "task_run_tutor_backup", state: "WAITING_FOR_APPROVAL", version: 3 }}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onChoose={(choice) => setChosen(choice)}
        chosenChoice={chosen}
        pending={false}
        safeErrorMessage={null}
      />
    </section>
  );
}

/** The providers catalog in its ready state. */
function ProvidersReadySurface() {
  return (
    <section data-surface="providers-settings" className="mx-auto max-w-xl px-6 py-8">
      <ProvidersSettingsView
        providers={[OLLAMA_PROVIDER]}
        surfaceState="ready"
        pendingConfirm={null}
        lastTestResult={null}
        configurePending={false}
        onConfigure={() => undefined}
        onReplaceCredential={() => undefined}
        onRevoke={() => undefined}
        onSetStatus={() => undefined}
        onConnectionTest={() => undefined}
      />
    </section>
  );
}

/**
 * The G4 configuration-failure surface: the real view in its error state with
 * the runtime's redacted safe message. This is the "provider configuration
 * failure path shows a configuration failure, never fake success" leg.
 */
function ProvidersFailureSurface() {
  return (
    <section data-surface="providers-failure" className="mx-auto max-w-xl px-6 py-8">
      <ProvidersSettingsView
        providers={[]}
        surfaceState="error"
        safeErrorMessage="The provider catalog could not be loaded. The runtime did not answer; check the connection and retry."
        onRetry={() => undefined}
        pendingConfirm={null}
        lastTestResult={null}
        configurePending={false}
        onConfigure={() => undefined}
        onReplaceCredential={() => undefined}
        onRevoke={() => undefined}
        onSetStatus={() => undefined}
        onConnectionTest={() => undefined}
      />
    </section>
  );
}

/** The credits read-out (§S12 row) — the S24 harness's proven mount. */
function CreditsSurface() {
  return (
    <section data-surface="credits-settings" className="mx-auto max-w-xl px-6 py-8">
      <CreditsSettingsView
        summary={CREDITS_SUMMARY}
        surfaceState="ready"
        safeErrorMessage={undefined}
        onRetry={() => undefined}
        selectedRunId={null}
        onSelectRun={() => undefined}
        drillDown={null}
        drillDownState="idle"
        pausedTriggerCount={0}
      />
    </section>
  );
}

const queryClient = new QueryClient();

// The wrapper is a div, not a main landmark: the shipped pages own their own
// main element (the login page renders one); a wrapping main here would
// duplicate the landmark on every harness page and mis-state the real app's
// structure (axe's landmark-no-duplicate-main on the S34 matrix).
function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div>
        <div data-view="login">
          <LoginPage />
        </div>
        <OperationChatSurface />
        <OperationArtifactsSurface />
        <ApprovalSurface />
        <ProvidersReadySurface />
        <ProvidersFailureSurface />
        <CreditsSurface />
      </div>
    </QueryClientProvider>
  );
}

// The five VERBATIM PRD §8 choice labels are asserted by the journeys spec —
// export them on the window in CONTRACT order for the specs to read without
// duplicating safety copy.
declare global {
  interface Window {
    SHERA_APPROVAL_CHOICE_LABELS?: readonly string[];
  }
}
window.SHERA_APPROVAL_CHOICE_LABELS = APPROVAL_CHOICE_ORDER.map(
  (choice) => APPROVAL_CHOICE_LABELS[choice],
);

createRoot(document.getElementById("root")!).render(<App />);

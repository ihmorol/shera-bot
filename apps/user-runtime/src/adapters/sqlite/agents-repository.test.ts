// S11 chunk 1 — agent identity data layer (red-first contract test).
// Vocabulary: Pack → Operations → Agents; "Expert" is a forbidden alias.
// Contract under test: durable, workspace-scoped agent records seeded from
// the pinned student pack, where re-seeding refreshes pack-owned fields but
// never clobbers the user-owned user_instructions / default provider fields.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAgentsRepository, seedAgentsFromPack } from './agents-repository';
// TODO(s11 chunk 1): align these helpers with the real connection.ts /
// migrations.ts exports in the implementation commit.
import { openDatabase } from './connection';
import { runMigrations } from './migrations';

interface ManifestAgent {
  agent_id: string;
  display_name: string;
  role_description: string;
  default_provider: { provider_id: string; model: string };
  skills: unknown[];
  tools: unknown[];
  connectors: unknown[];
  ui_identity: { avatar_hue: number; initial_glyph: string };
  home_operation_id: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const studentManifestPath = path.resolve(
  here,
  '../../../../../agent-packs/student/v1/manifest.json',
);
const studentManifest: { agents: ManifestAgent[] } = JSON.parse(
  readFileSync(studentManifestPath, 'utf8'),
);

function createTestDatabase() {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

let db: ReturnType<typeof createTestDatabase>;

beforeEach(() => {
  db = createTestDatabase();
});

describe('agents repository (S11 chunk 1)', () => {
  it('seeds the six student-pack agents with pack-owned fields', () => {
    const repo = createAgentsRepository(db);
    const result = repo.upsertFromPack('ws-primary', studentManifest.agents);

    expect(result.insertedAgentIds).toHaveLength(6);
    expect(result.updatedAgentIds).toEqual([]);
    expect(result.orphanedAgentIds).toEqual([]);

    const agents = repo.listAgents('ws-primary');
    expect(agents).toHaveLength(6);
    expect(agents.map((agent) => agent.agentId).sort()).toEqual(
      studentManifest.agents.map((agent) => agent.agent_id).sort(),
    );

    const manifestGeneral = studentManifest.agents.find(
      (agent) => agent.agent_id === 'agent_general_assistant',
    );
    expect(manifestGeneral).toBeDefined();
    // Actual manifest value (S11 brief): agent_general_assistant / hue 217.
    expect(manifestGeneral!.ui_identity.avatar_hue).toBe(217);

    const general = repo.getAgent('ws-primary', 'agent_general_assistant');
    expect(general).not.toBeNull();
    expect(general).toMatchObject({
      agentId: 'agent_general_assistant',
      workspaceId: 'ws-primary',
      displayName: manifestGeneral!.display_name,
      roleDescription: manifestGeneral!.role_description,
      avatarHue: 217,
      initialGlyph: manifestGeneral!.ui_identity.initial_glyph,
      defaultProviderId: manifestGeneral!.default_provider.provider_id,
      defaultProviderModel: manifestGeneral!.default_provider.model,
      homeOperationId: manifestGeneral!.home_operation_id,
      privateFolderPath: 'agent://agent_general_assistant/',
      isSeededFromPack: true,
      userInstructions: null,
    });
    expect(JSON.parse(general!.capabilitiesJson)).toEqual({
      skills: manifestGeneral!.skills,
      tools: manifestGeneral!.tools,
      connectors: manifestGeneral!.connectors,
    });

    for (const agent of agents) {
      expect(agent.privateFolderPath).toBe(`agent://${agent.agentId}/`);
      expect(agent.isSeededFromPack).toBe(true);
    }
  });

  it('seedAgentsFromPack maps a loaded pack manifest onto upsertFromPack', () => {
    const result = seedAgentsFromPack(db, 'ws-primary', studentManifest);
    expect(result.insertedAgentIds).toHaveLength(6);
    expect(createAgentsRepository(db).listAgents('ws-primary')).toHaveLength(6);
  });

  it('re-seeding an unchanged pack reports no inserts, updates, or orphans', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const result = repo.upsertFromPack('ws-primary', studentManifest.agents);
    expect(result.insertedAgentIds).toEqual([]);
    expect(result.updatedAgentIds).toEqual([]);
    expect(result.orphanedAgentIds).toEqual([]);
    expect(repo.listAgents('ws-primary')).toHaveLength(6);
  });

  it('re-seeding refreshes pack-owned fields but never clobbers user-owned fields', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);
    repo.updateUserInstructions(
      'ws-primary',
      'agent_general_assistant',
      'Always answer in Bengali.',
    );
    repo.updateDefaultProvider(
      'ws-primary',
      'agent_general_assistant',
      'user-pick',
      'user/selected-model',
    );

    const mutated = structuredClone(studentManifest.agents);
    const general = mutated.find(
      (agent) => agent.agent_id === 'agent_general_assistant',
    )!;
    general.display_name = 'Renamed Assistant';
    general.role_description = 'Renamed role description';
    general.ui_identity.avatar_hue = 42;
    general.default_provider = { provider_id: 'pack-pick', model: 'pack/model' };

    const result = repo.upsertFromPack('ws-primary', mutated);
    expect(result.insertedAgentIds).toEqual([]);
    expect(result.updatedAgentIds).toContain('agent_general_assistant');

    const updated = repo.getAgent('ws-primary', 'agent_general_assistant')!;
    expect(updated.userInstructions).toBe('Always answer in Bengali.');
    expect(updated.defaultProviderId).toBe('user-pick');
    expect(updated.defaultProviderModel).toBe('user/selected-model');
    expect(updated.displayName).toBe('Renamed Assistant');
    expect(updated.roleDescription).toBe('Renamed role description');
    expect(updated.avatarHue).toBe(42);
  });

  it('leaves removed pack agents in place and reports them as orphaned', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const withoutGeneral = studentManifest.agents.filter(
      (agent) => agent.agent_id !== 'agent_general_assistant',
    );
    const result = repo.upsertFromPack('ws-primary', withoutGeneral);
    expect(result.orphanedAgentIds).toEqual(['agent_general_assistant']);
    expect(repo.getAgent('ws-primary', 'agent_general_assistant')).not.toBeNull();
    expect(repo.listAgents('ws-primary')).toHaveLength(6);
  });

  it('inserts newly added pack agents on re-seed', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const extended: ManifestAgent[] = [
      ...studentManifest.agents,
      {
        agent_id: 'agent_newcomer',
        display_name: 'Newcomer',
        role_description: 'Added by a later pack version',
        default_provider: { provider_id: 'openrouter', model: 'test/model' },
        skills: [],
        tools: [],
        connectors: [],
        ui_identity: { avatar_hue: 10, initial_glyph: 'N' },
        home_operation_id: null,
      },
    ];

    const result = repo.upsertFromPack('ws-primary', extended);
    expect(result.insertedAgentIds).toEqual(['agent_newcomer']);
    expect(repo.getAgent('ws-primary', 'agent_newcomer')).not.toBeNull();
    expect(repo.listAgents('ws-primary')).toHaveLength(7);
  });

  it('updates user instructions and rejects unknown agents', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    repo.updateUserInstructions(
      'ws-primary',
      'agent_general_assistant',
      'Never send drafts without review.',
    );
    expect(
      repo.getAgent('ws-primary', 'agent_general_assistant')!.userInstructions,
    ).toBe('Never send drafts without review.');

    repo.updateUserInstructions('ws-primary', 'agent_general_assistant', null);
    expect(
      repo.getAgent('ws-primary', 'agent_general_assistant')!.userInstructions,
    ).toBeNull();

    expect(() =>
      repo.updateUserInstructions('ws-primary', 'agent_missing', 'nope'),
    ).toThrowError();
  });

  it('updates the default provider for an agent', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    repo.updateDefaultProvider(
      'ws-primary',
      'agent_general_assistant',
      'anthropic',
      'claude-sonnet-x',
    );
    const general = repo.getAgent('ws-primary', 'agent_general_assistant')!;
    expect(general.defaultProviderId).toBe('anthropic');
    expect(general.defaultProviderModel).toBe('claude-sonnet-x');

    expect(() =>
      repo.updateDefaultProvider('ws-primary', 'agent_missing', 'a', 'b'),
    ).toThrowError();
  });

  it('stores and returns raw per-agent settings JSON', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const agentId = 'agent_general_assistant';
    expect(repo.getSettings('ws-primary', agentId)).toEqual({});

    const settings = { temperature: 0.2, tone: 'warm' };
    repo.updateSettings('ws-primary', agentId, settings);
    expect(repo.getSettings('ws-primary', agentId)).toEqual(settings);

    const replaced = { tone: 'concise' };
    repo.updateSettings('ws-primary', agentId, replaced);
    expect(repo.getSettings('ws-primary', agentId)).toEqual(replaced);
  });

  it('round-trips private memory entries per agent', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const agentId = 'agent_general_assistant';
    repo.addMemoryEntry('ws-primary', agentId, 'Prefers morning summaries.');
    repo.addMemoryEntry('ws-primary', agentId, 'Allergic to shellfish.');

    const entries = repo.listMemoryEntries('ws-primary', agentId);
    expect(entries.map((entry) => entry.content)).toEqual([
      'Prefers morning summaries.',
      'Allergic to shellfish.',
    ]);
    expect(entries.every((entry) => entry.agentId === agentId)).toBe(true);
  });

  it('round-trips the task history ledger per agent', () => {
    const repo = createAgentsRepository(db);
    repo.upsertFromPack('ws-primary', studentManifest.agents);

    const agentId = 'agent_general_assistant';
    repo.addTaskHistoryEntry('ws-primary', agentId, 'task-001');
    repo.addTaskHistoryEntry('ws-primary', agentId, 'task-002');

    const rows = repo.listTaskHistory('ws-primary', agentId);
    expect(rows.map((row) => row.taskId)).toEqual(['task-001', 'task-002']);
    expect(rows.every((row) => row.agentId === agentId)).toBe(true);
  });

  it('scopes all agent data to its workspace', () => {
    const repo = createAgentsRepository(db);
    // Both workspaces seed the same pinned pack; identical agent_ids must
    // coexist across workspaces.
    repo.upsertFromPack('ws-alpha', studentManifest.agents);
    repo.upsertFromPack('ws-beta', studentManifest.agents);

    repo.updateUserInstructions('ws-alpha', 'agent_general_assistant', 'alpha rules');
    repo.updateSettings('ws-beta', 'agent_general_assistant', { tone: 'beta' });
    repo.addMemoryEntry('ws-beta', 'agent_general_assistant', 'beta memory');

    expect(repo.listAgents('ws-alpha').every((a) => a.workspaceId === 'ws-alpha')).toBe(true);
    expect(repo.listAgents('ws-beta').every((a) => a.workspaceId === 'ws-beta')).toBe(true);
    expect(repo.listAgents('ws-alpha')).toHaveLength(6);
    expect(repo.listAgents('ws-beta')).toHaveLength(6);

    expect(repo.getAgent('ws-alpha', 'agent_general_assistant')!.userInstructions).toBe(
      'alpha rules',
    );
    expect(repo.getAgent('ws-beta', 'agent_general_assistant')!.userInstructions).toBeNull();

    expect(repo.getSettings('ws-alpha', 'agent_general_assistant')).toEqual({});
    expect(repo.getSettings('ws-beta', 'agent_general_assistant')).toEqual({ tone: 'beta' });

    expect(repo.listMemoryEntries('ws-alpha', 'agent_general_assistant')).toEqual([]);
    expect(repo.listMemoryEntries('ws-beta', 'agent_general_assistant')).toHaveLength(1);

    expect(repo.getAgent('ws-alpha', 'agent_does_not_exist')).toBeNull();
    expect(repo.listAgents('ws-unknown')).toEqual([]);
  });
});

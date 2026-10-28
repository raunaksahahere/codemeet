import type { ActivityEntry, GrantView, JoinRequestView, MessageView, Participant, ProposalView } from '@codemeet/shared';

export interface UiState {
  phase: 'idle' | 'starting' | 'syncing' | 'offline' | 'closed';
  detail: string;
  roomId: string;
  serverUrl: string;
  role: 'host' | 'guest' | null;
  participants: Participant[];
  pending: JoinRequestView[];
  proposals: ProposalView[];
  grants: GrantView[];
  messages: MessageView[];
  activity: ActivityEntry[];
  myAgents: Record<string, string>;
  where: Record<string, string>;
}

export const emptyState = (): UiState => ({
  phase: 'idle', detail: '', roomId: '', serverUrl: '', role: null, participants: [], pending: [],
  proposals: [], grants: [], messages: [], activity: [], myAgents: {}, where: {},
});

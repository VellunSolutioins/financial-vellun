import { apiClient } from './api-client';

export interface MemberSummary {
  id: string;
  name: string;
  email: string;
  isOwner: boolean;
  createdAt?: string;
}

export interface MembersState {
  owner: MemberSummary;
  members: MemberSummary[];
  maxMembers: number;
}

export interface MemberInvite {
  id: string;
  email: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  inviteUrl?: string;
}

export interface InviteInfo {
  email: string;
  ownerName: string;
}

export const getMembers = () => apiClient.get<MembersState>('/members');

export const getInvites = () => apiClient.get<MemberInvite[]>('/members/invites');

export const inviteMember = (email: string) =>
  apiClient.post<MemberInvite>('/members/invite', { email });

export const revokeInvite = (id: string) =>
  apiClient.delete<{ message: string }>(`/members/invites/${id}`);

export const removeMember = (id: string) =>
  apiClient.delete<{ message: string }>(`/members/${id}`);

export const getInviteByToken = (token: string) =>
  apiClient.get<InviteInfo>(`/members/invite/${token}`);

export const acceptInvite = (data: { token: string; name: string; password: string }) =>
  apiClient.post('/members/accept-invite', data);

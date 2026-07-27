import { apiClient } from './api-client';

export interface Address {
  postalCode?: string | null;
  street?: string | null;
  addressNumber?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
}

export interface User extends Address {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  profileType: 'individual' | 'business';
  hasProfile: boolean;
  createdAt: string;
  updatedAt: string;
}

export async function register(data: {
  name: string;
  email: string;
  phone: string;
  password: string;
  postalCode: string;
  street: string;
  addressNumber: string;
  complement?: string;
  neighborhood: string;
  city: string;
  state: string;
  profileType: 'individual' | 'business';
  cpf?: string;
  birthDate?: string;
  companyName?: string;
  tradeName?: string;
  cnpj?: string;
}): Promise<User> {
  return apiClient.post<User>('/auth/register', data);
}

export async function login(data: { email: string; password: string }): Promise<User> {
  return apiClient.post<User>('/auth/login', data);
}

export async function logout(): Promise<void> {
  await apiClient.post('/auth/logout', {});
}

/** Pede o link de redefinição. A resposta é genérica (não revela se o e-mail existe). */
export async function forgotPassword(email: string): Promise<{ message: string }> {
  return apiClient.post<{ message: string }>('/auth/forgot-password', { email });
}

export async function resetPassword(data: {
  token: string;
  newPassword: string;
}): Promise<{ message: string }> {
  return apiClient.post<{ message: string }>('/auth/reset-password', data);
}

export async function getMe(): Promise<User> {
  return apiClient.get<User>('/auth/me');
}

export async function updateMe(data: {
  name?: string;
  email?: string;
  phone?: string | null;
  postalCode?: string;
  street?: string;
  addressNumber?: string;
  complement?: string;
  neighborhood?: string;
  city?: string;
  state?: string;
}): Promise<User> {
  return apiClient.patch<User>('/users/me', data);
}

export interface IndividualProfile {
  cpf: string;
  birthDate?: string | null;
}

export interface BusinessProfile {
  companyName: string;
  tradeName?: string | null;
  cnpj: string;
}

export interface ProfileResponse {
  profileType: 'individual' | 'business';
  individualProfile?: IndividualProfile | null;
  businessProfile?: BusinessProfile | null;
}

export async function getProfile(): Promise<ProfileResponse> {
  return apiClient.get<ProfileResponse>('/users/me/profile');
}

export async function updateIndividualProfile(data: {
  cpf: string;
  birthDate?: string;
}): Promise<IndividualProfile> {
  return apiClient.post<IndividualProfile>('/users/me/profile/individual', data);
}

export async function updateBusinessProfile(data: {
  companyName: string;
  tradeName?: string;
  cnpj: string;
}): Promise<BusinessProfile> {
  return apiClient.post<BusinessProfile>('/users/me/profile/business', data);
}

export async function updatePassword(data: {
  currentPassword: string;
  newPassword: string;
}): Promise<{ message: string }> {
  return apiClient.patch<{ message: string }>('/users/me/password', data);
}

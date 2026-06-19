import { apiClient } from './api-client';

export interface User {
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
  password: string;
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

export async function getMe(): Promise<User> {
  return apiClient.get<User>('/auth/me');
}

export async function updateMe(data: {
  name?: string;
  email?: string;
  phone?: string | null;
}): Promise<User> {
  return apiClient.patch<User>('/users/me', data);
}

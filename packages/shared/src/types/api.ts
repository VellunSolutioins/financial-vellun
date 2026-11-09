export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    total_pages: number;
  };
}

/** Erro ligado a um campo do corpo enviado (validação ou valor já em uso). */
export interface ApiFieldError {
  field: string;
  message: string;
}

export interface ApiError {
  statusCode: number;
  /** Lista nos erros de validação; texto único nos demais. */
  message: string | string[];
  error: string;
  /** Presente quando a API sabe a qual campo cada mensagem pertence. */
  errors?: ApiFieldError[];
}

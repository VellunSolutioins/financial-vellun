/**
 * Validação de dígito verificador de CPF e CNPJ. O regex de formato
 * (`@Matches`) garante a máscara; estas funções garantem que o número é
 * matematicamente válido — sem isso, documentos como `111.111.111-11` passam no
 * cadastro e só são recusados pelo provedor de pagamentos.
 */

/** Valida o CPF (11 dígitos) pelo dígito verificador. Aceita com ou sem máscara. */
export function isValidCpf(input: string): boolean {
  const cpf = input.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(cpf[i]) * (10 - i);
  let check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  if (check !== Number(cpf[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(cpf[i]) * (11 - i);
  check = 11 - (sum % 11);
  if (check >= 10) check = 0;
  return check === Number(cpf[10]);
}

/** Valida o CNPJ (14 dígitos) pelo dígito verificador. Aceita com ou sem máscara. */
export function isValidCnpj(input: string): boolean {
  const cnpj = input.replace(/\D/g, '');
  if (cnpj.length !== 14 || /^(\d)\1{13}$/.test(cnpj)) return false;

  const digit = (length: number): number => {
    const weights =
      length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < length; i++) sum += Number(cnpj[i]) * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };

  if (digit(12) !== Number(cnpj[12])) return false;
  return digit(13) === Number(cnpj[13]);
}

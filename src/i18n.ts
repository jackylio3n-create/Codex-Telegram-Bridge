export type PromptLanguage = "zh" | "en";

export function zhEn(zh: string, en: string): string {
  return `${zh}\n${en}`;
}

export function zhEnInline(zh: string, en: string): string {
  return `${zh} / ${en}`;
}

export function selectText(language: PromptLanguage, zh: string, en: string): string {
  return language === "zh" ? zh : en;
}

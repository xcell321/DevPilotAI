export function briefText(value: string, maxLength = 140): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text;
}

export function taskTitle(description: string, fallback = ''): string {
  const firstSentence = description.split(/(?<=\.)\s+/)[0] ?? description;
  return briefText(firstSentence, 78) || fallback;
}

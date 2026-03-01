function escapeHtml(text = '') {
  return String(text || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function normalizeNewlines(text = '') {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripFenceLanguageHint(code = '') {
  const value = String(code || '').replace(/^\n+|\n+$/g, '');
  const firstLineBreak = value.indexOf('\n');
  if (firstLineBreak === -1) {
    return value;
  }
  const firstLine = value.slice(0, firstLineBreak).trim();
  if (/^[a-z0-9_+-]{1,20}$/i.test(firstLine)) {
    return value.slice(firstLineBreak + 1).trim();
  }
  return value;
}

export function toTelegramHtml(rawText = '') {
  let text = escapeHtml(normalizeNewlines(rawText));

  text = text.replace(/```([\s\S]*?)```/g, (_match, code) => {
    const compact = stripFenceLanguageHint(code);
    return `<pre>${compact}</pre>`;
  });

  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  text = text.replace(/^\s*---+\s*$/gm, '────────');
  text = text.replace(/^\s*[-*]\s+/gm, '• ');
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');

  return text.trim();
}

export function toTelegramPlainText(rawText = '') {
  let text = normalizeNewlines(rawText);
  text = text.replace(/```([\s\S]*?)```/g, (_match, code) => stripFenceLanguageHint(code));
  text = text.replace(/`([^`\n]+)`/g, '$1');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');
  text = text.replace(/^\s*---+\s*$/gm, '────────');
  text = text.replace(/^\s*[-*]\s+/gm, '• ');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1: $2');
  return text.trim();
}

export default {
  toTelegramHtml,
  toTelegramPlainText,
};

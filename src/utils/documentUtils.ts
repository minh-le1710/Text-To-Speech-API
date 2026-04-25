const sentenceSeparator = /(?<=[.!?;:])\s+/u;

export const normalizeText = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const splitByWords = (segment: string, maxChars: number) => {
  const parts: string[] = [];
  const words = segment.split(/\s+/).filter(Boolean);
  let current = '';

  for (const word of words) {
    if (word.length > maxChars) {
      if (current) {
        parts.push(current);
        current = '';
      }

      for (let start = 0; start < word.length; start += maxChars) {
        parts.push(word.slice(start, start + maxChars));
      }

      continue;
    }

    const next = current ? `${current} ${word}` : word;

    if (next.length > maxChars) {
      parts.push(current);
      current = word;
      continue;
    }

    current = next;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
};

export const splitTextIntoChunks = (text: string, maxChars: number) => {
  const normalized = normalizeText(text);

  if (!normalized) {
    return [];
  }

  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const chunks: string[] = [];
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  let current = '';

  const pushChunk = (value: string) => {
    const chunk = value.trim();

    if (chunk) {
      chunks.push(chunk);
    }
  };

  for (const paragraph of paragraphs) {
    const units = paragraph.split(sentenceSeparator).filter(Boolean);

    for (const unit of units) {
      if (unit.length > maxChars) {
        const wordChunks = splitByWords(unit, maxChars);

        for (const wordChunk of wordChunks) {
          if (current) {
            pushChunk(current);
            current = '';
          }

          pushChunk(wordChunk);
        }

        continue;
      }

      const candidate = current ? `${current} ${unit}` : unit;

      if (candidate.length > maxChars) {
        pushChunk(current);
        current = unit;
        continue;
      }

      current = candidate;
    }

    if (current) {
      pushChunk(current);
      current = '';
    }
  }

  return chunks;
};

export const sanitizeFileName = (value: string) =>
  value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

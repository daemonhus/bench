import React from 'react';

/**
 * Lightweight markdown renderer.
 * Inline: **bold**, *italic*, `code`, [links](url), ~~strikethrough~~
 * Block: fenced code blocks (``` ... ```)
 */

interface Segment {
  type: 'text' | 'bold' | 'italic' | 'code' | 'link' | 'autolink' | 'strike';
  text: string;
  href?: string;
  children?: Segment[];
}

// Order matters: check longer patterns first
const INLINE_RULES: { pattern: RegExp; type: Segment['type'] }[] = [
  { pattern: /`([^`]+?)`/, type: 'code' },
  { pattern: /\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/, type: 'link' },
  { pattern: /(https?:\/\/[^\s<>)"]+)/, type: 'autolink' },
  { pattern: /\*\*(.+?)\*\*/, type: 'bold' },
  { pattern: /~~(.+?)~~/, type: 'strike' },
  { pattern: /\*(.+?)\*/, type: 'italic' },
];

function parseInline(input: string): Segment[] {
  const segments: Segment[] = [];
  let remaining = input;

  while (remaining.length > 0) {
    let earliest: { index: number; match: RegExpExecArray; type: Segment['type'] } | null = null;

    for (const rule of INLINE_RULES) {
      const re = new RegExp(rule.pattern.source, 'g');
      const m = re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.index)) {
        earliest = { index: m.index, match: m, type: rule.type };
      }
    }

    if (!earliest) {
      segments.push({ type: 'text', text: remaining });
      break;
    }

    if (earliest.index > 0) {
      segments.push({ type: 'text', text: remaining.slice(0, earliest.index) });
    }

    const seg: Segment = { type: earliest.type, text: earliest.match[1] };
    if (earliest.type === 'link') {
      seg.href = earliest.match[2];
    }
    if (earliest.type === 'autolink') {
      seg.href = earliest.match[1];
    }
    if (earliest.type === 'bold' || earliest.type === 'italic' || earliest.type === 'strike') {
      seg.children = parseInline(earliest.match[1]);
    }
    segments.push(seg);

    remaining = remaining.slice(earliest.index + earliest.match[0].length);
  }

  return segments;
}

function renderSegment(seg: Segment, key: number): React.ReactNode {
  switch (seg.type) {
    case 'text':
      return <span key={key}>{seg.text}</span>;
    case 'code':
      return <code key={key} className="md-code">{seg.text}</code>;
    case 'bold':
      return <strong key={key}>{seg.children?.map(renderSegment) ?? seg.text}</strong>;
    case 'italic':
      return <em key={key}>{seg.children?.map(renderSegment) ?? seg.text}</em>;
    case 'strike':
      return <s key={key}>{seg.children?.map(renderSegment) ?? seg.text}</s>;
    case 'link':
      return (
        <a key={key} className="md-link" href={seg.href} target="_blank" rel="noopener noreferrer">
          {seg.text}
        </a>
      );
    case 'autolink':
      return (
        <a key={key} className="md-link" href={seg.href} target="_blank" rel="noopener noreferrer">
          {seg.text}
        </a>
      );
    default:
      return <span key={key}>{seg.text}</span>;
  }
}

interface Block {
  type: 'prose' | 'code';
  content: string;
  lang?: string;
}

/** Split text into prose and fenced code blocks. */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');
  let i = 0;
  let prose: string[] = [];

  while (i < lines.length) {
    const fence = lines[i].match(/^```(\w*)\s*$/);
    if (fence) {
      // Flush accumulated prose
      if (prose.length > 0) {
        blocks.push({ type: 'prose', content: prose.join('\n') });
        prose = [];
      }
      const lang = fence[1] || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', content: codeLines.join('\n'), lang });
      i++; // skip closing ```
    } else {
      prose.push(lines[i]);
      i++;
    }
  }
  if (prose.length > 0) {
    blocks.push({ type: 'prose', content: prose.join('\n') });
  }
  return blocks;
}

function renderProse(text: string): React.ReactNode[] {
  const lines = text.split('\n');
  return lines.map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {parseInline(line).map(renderSegment)}
    </React.Fragment>
  ));
}

export const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const blocks = parseBlocks(text);

  // Fast path: single prose block (no code fences)
  if (blocks.length === 1 && blocks[0].type === 'prose') {
    return <>{renderProse(blocks[0].content)}</>;
  }

  return (
    <>
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <pre key={i} className="md-codeblock">
            <code>{block.content}</code>
          </pre>
        ) : (
          <React.Fragment key={i}>{renderProse(block.content)}</React.Fragment>
        ),
      )}
    </>
  );
};

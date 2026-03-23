import { refractor } from 'refractor';

const extToLang: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.css': 'css',
  '.html': 'markup',
  '.htm': 'markup',
  '.xml': 'markup',
  '.svg': 'markup',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.sql': 'sql',
  '.rb': 'ruby',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.toml': 'toml',
  '.lua': 'lua',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.r': 'r',
  '.R': 'r',
  '.dockerfile': 'docker',
  '.proto': 'protobuf',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.scss': 'scss',
  '.less': 'less',
  '.diff': 'diff',
  '.patch': 'diff',
  '.php': 'php',
  '.pl': 'perl',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.scala': 'scala',
  '.vim': 'vim',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.cs': 'csharp',
  '.m': 'objectivec',
  '.makefile': 'makefile',
};

export function detectLanguage(filePath: string): string | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) {
    // Handle special filenames
    const name = filePath.split('/').pop()?.toLowerCase() ?? '';
    if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
    if (name === 'dockerfile') return 'docker';
    return null;
  }
  const ext = filePath.slice(dot).toLowerCase();
  return extToLang[ext] ?? null;
}

export async function ensureLanguageRegistered(lang: string): Promise<void> {
  if (refractor.registered(lang)) return;
  try {
    const mod = await import(`../../node_modules/refractor/lang/${lang}.js`);
    refractor.register(mod.default);
  } catch {
    // Language module not available — highlight will fall back to plain text
  }
}

/**
 * Shared Obsidian vault configuration for company folders.
 *
 * Must match the source-of-truth template in hq-core-staging at
 * `companies/_template/.obsidian/` and the S3-scaffold copy in
 * hq-onboarding at `src/app/api/provision/scaffold/obsidian-config.ts`.
 *
 * When updating this file, update the other two in lock-step — the three
 * surfaces all need to produce identical vault config so a company opens
 * the same way whether it was scaffolded locally (this installer), via
 * the web wizard (hq-onboarding → S3 → hq-sync), or by `/newcompany` in
 * the HQ tree (template copy).
 */

export const OBSIDIAN_APP = {
  useMarkdownLinks: true,
  defaultViewMode: 'preview',
  readableLineLength: true,
  showFrontmatter: true,
  foldHeading: true,
  foldIndent: true,
  showLineNumber: false,
  strictLineBreaks: false,
  attachmentFolderPath: 'data/attachments',
  newFileLocation: 'folder',
  newFileFolderPath: 'knowledge',
  userIgnoreFilters: ['settings/', 'repos/', 'node_modules/', '.git/', 'workspace/sessions/'],
  alwaysUpdateLinks: true,
  showUnsupportedFiles: false,
  promptDelete: false,
};

export const OBSIDIAN_GRAPH = {
  'collapse-filter': false,
  search: '',
  showTags: true,
  showAttachments: false,
  hideUnresolved: false,
  showOrphans: false,
  'collapse-color-groups': false,
  colorGroups: [
    { query: 'path:ontology/entities/person', color: { a: 1, rgb: 16750848 } },
    { query: 'path:ontology/entities/company', color: { a: 1, rgb: 4890367 } },
    { query: 'path:ontology/entities/product', color: { a: 1, rgb: 4905600 } },
    { query: 'path:ontology/entities/event', color: { a: 1, rgb: 16498436 } },
    { query: 'path:ontology/entities/', color: { a: 1, rgb: 9740984 } },
    { query: 'path:knowledge/', color: { a: 1, rgb: 5592575 } },
    { query: 'path:policies/', color: { a: 1, rgb: 16486460 } },
    { query: 'path:projects/', color: { a: 1, rgb: 8388352 } },
  ],
  'collapse-display': false,
  showArrow: true,
  textFadeMultiplier: 0,
  nodeSizeMultiplier: 1.2,
  lineSizeMultiplier: 1,
  'collapse-forces': false,
  centerStrength: 0.5,
  repelStrength: 12,
  linkStrength: 1,
  linkDistance: 200,
  scale: 1,
  close: false,
};

export const OBSIDIAN_APPEARANCE = {
  theme: 'system',
  cssTheme: '',
  baseFontSize: 16,
  enabledCssSnippets: [],
  interfaceFontFamily: '',
  textFontFamily: '',
  monospaceFontFamily: '',
};

export const OBSIDIAN_CORE_PLUGINS = {
  'file-explorer': true,
  'global-search': true,
  graph: true,
  backlink: true,
  'outgoing-link': true,
  outline: true,
  'tag-pane': true,
  properties: true,
  'page-preview': true,
  'file-recovery': true,
  'command-palette': true,
  switcher: true,
  'markdown-importer': false,
  'daily-notes': false,
  templates: false,
  'note-composer': false,
  'editor-status': false,
  'word-count': false,
  'slash-command': false,
  canvas: false,
  workspaces: false,
  publish: false,
  sync: false,
  'audio-recorder': false,
  'zk-prefixer': false,
  'random-note': false,
  slides: false,
  footnotes: false,
  webviewer: false,
};

export const OBSIDIAN_TYPES = {
  types: {
    type: 'text',
    domain: 'multitext',
    status: 'text',
    tags: 'multitext',
    relates_to: 'multitext',
    description: 'text',
    entity_type: 'text',
    confidence: 'number',
    source: 'text',
    last_seen: 'date',
  },
};

export const OBSIDIAN_WORKSPACE = {
  main: {
    id: 'main',
    type: 'split',
    children: [
      {
        id: 'main-tabs',
        type: 'tabs',
        children: [
          {
            id: 'graph-leaf',
            type: 'leaf',
            state: { type: 'graph', state: {}, icon: 'lucide-git-fork', title: 'Graph view' },
          },
        ],
      },
    ],
    direction: 'vertical',
  },
  left: {
    id: 'left',
    type: 'split',
    children: [
      {
        id: 'left-tabs',
        type: 'tabs',
        children: [
          {
            id: 'file-explorer',
            type: 'leaf',
            state: {
              type: 'file-explorer',
              state: { sortOrder: 'alphabetical', autoReveal: true },
              icon: 'lucide-folder-closed',
              title: 'Files',
            },
          },
          {
            id: 'search-leaf',
            type: 'leaf',
            state: {
              type: 'search',
              state: { query: '', matchingCase: false, explainSearch: false, collapseAll: false, extraContext: false, sortOrder: 'alphabetical' },
              icon: 'lucide-search',
              title: 'Search',
            },
          },
        ],
      },
    ],
    direction: 'horizontal',
    width: 260,
  },
  right: {
    id: 'right',
    type: 'split',
    children: [
      {
        id: 'right-tabs',
        type: 'tabs',
        children: [
          {
            id: 'backlink-leaf',
            type: 'leaf',
            state: {
              type: 'backlink',
              state: { collapseAll: false, extraContext: false, sortOrder: 'alphabetical', showSearch: false, searchQuery: '', backlinkCollapsed: false, unlinkedCollapsed: true },
              icon: 'links-coming-in',
              title: 'Backlinks',
            },
          },
          {
            id: 'outgoing-link-leaf',
            type: 'leaf',
            state: { type: 'outgoing-link', state: { linksCollapsed: false, unlinkedCollapsed: true }, icon: 'links-going-out', title: 'Outgoing links' },
          },
          {
            id: 'tag-leaf',
            type: 'leaf',
            state: { type: 'tag', state: { sortOrder: 'frequency', useHierarchy: true, showSearch: false, searchQuery: '' }, icon: 'lucide-tags', title: 'Tags' },
          },
        ],
      },
    ],
    direction: 'horizontal',
    width: 260,
  },
  'left-ribbon': { hiddenItems: {} },
  active: 'graph-leaf',
  lastOpenFiles: [],
};

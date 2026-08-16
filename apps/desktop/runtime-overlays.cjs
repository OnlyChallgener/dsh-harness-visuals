'use strict'

/**
 * Local package libraries that must replace the published runtime copies.
 * The Desktop runtime intentionally starts from the pinned published DSH tree,
 * then overlays only packages changed by this fork. This keeps upstream runtime
 * breadth while making the fork's visible/runtime behavior deterministic.
 */
module.exports = Object.freeze([
  {
    name: '@deepseek-ai/dsh-client-ui-agent-preset',
    repoPath: 'packages/client/ui-agent-preset',
    markers: ['change applies from the next turn'],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-attachment',
    repoPath: 'packages/client/ui-attachment',
    markers: [],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-conversation',
    repoPath: 'packages/client/ui-conversation',
    markers: [],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-layout',
    repoPath: 'packages/client/ui-layout',
    markers: ['--dsh-wallpaper-image', 'data-dsh-local-wallpaper'],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-primitives',
    repoPath: 'packages/client/ui-primitives',
    markers: [],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    repoPath: 'packages/client/ui-settings-plugin-inventory',
    markers: ['marketplaceTitle', 'marketplaceRecommended'],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-theme',
    repoPath: 'packages/client/ui-theme',
    markers: ['appearance.wallpaper', 'Choose wallpaper', 'data-dsh-local-wallpaper'],
  },
  {
    name: '@deepseek-ai/dsh-tool-cordis',
    repoPath: 'packages/extensions/tool-cordis',
    markers: [],
  },
  {
    name: '@deepseek-ai/dsh-host-apiproxy',
    repoPath: 'packages/host/apiproxy',
    markers: [],
  },
  {
    name: '@deepseek-ai/dsh-agent-presets',
    repoPath: 'packages/preset/agent-presets',
    markers: [],
  },
])

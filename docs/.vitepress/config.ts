import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Bench",
  description: "A review workbench designed for people who work with code.",
  base: "/bench/",
  cleanUrls: true,
  ignoreDeadLinks: true,

  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/quickstart" },
      { text: "Concepts", link: "/concepts/annotations" },
      { text: "Reference", link: "/cli/" },
    ],

    sidebar: [
      { text: "<em>Philosophy</em>", link: "/philosophy" },
      {
        text: "Getting Started",
        items: [
          { text: "Quickstart", link: "/guide/quickstart" },
          { text: "Docker", link: "/guide/docker" },
        ],
      },
      {
        text: "Concepts",
        items: [
          { text: "Annotations", link: "/concepts/annotations" },
          { text: "Deltas", link: "/concepts/deltas" },
          { text: "Reconciling", link: "/concepts/reconciling" },
        ],
      },
      {
        text: "Usage",
        items: [
          { text: "Browse", link: "/panel/browse" },
          { text: "Changes & Baselines", link: "/panel/changes" },
          { text: "Findings", link: "/panel/findings" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/cli/" },
          { text: "API", link: "/api/bench" },
          { text: "MCP", link: "/mcp/" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/daemonhus/bench" },
    ],

    search: {
      provider: "local",
    },
  },
});

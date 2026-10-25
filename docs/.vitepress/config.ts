import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Bench",
  description: "A workbench for code review.",
  base: "/bench/",
  cleanUrls: true,
  // Pages show the local server's address; every other link must resolve.
  ignoreDeadLinks: "localhostLinks",

  themeConfig: {
    nav: [
      { text: "Get started", link: "/start" },
      { text: "Concepts", link: "/concepts/annotations" },
      { text: "Reference", link: "/reference/cli" },
    ],

    sidebar: [
      { text: "<em>Philosophy</em>", link: "/philosophy" },
      { text: "Getting started", link: "/start" },
      { text: "Using the UI", link: "/ui" },
      {
        text: "Concepts",
        items: [
          { text: "Annotations", link: "/concepts/annotations" },
          { text: "Features", link: "/concepts/features" },
          { text: "Baselines & deltas", link: "/concepts/baselines" },
          { text: "Reconciling", link: "/concepts/reconciling" },
          { text: "Review branch", link: "/concepts/review-branch" },
          { text: "Projects & flows", link: "/concepts/multi-project" },
        ],
      },
      {
        text: "Reference",
        items: [
          { text: "CLI", link: "/reference/cli" },
          { text: "API", link: "/reference/api" },
          { text: "MCP", link: "/reference/mcp" },
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

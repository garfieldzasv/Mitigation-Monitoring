import { createApp } from "vue";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import { recordInitialRoute } from "./app/session";
import "./app/styles/base.css";

recordInitialRoute();

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", component: () => import("./app/pages/MonitorPage.vue") },
    { path: "/review", component: () => import("./app/pages/ReviewPage.vue") },
    { path: "/settings", component: () => import("./app/pages/SettingsPage.vue") },
    // Runtime checks for ACT's embedded browser (docs/DESIGN.md 11.2). Not linked from the UI.
    { path: "/probe", component: () => import("./app/pages/ProbePage.vue") },
    { path: "/probe-popup", component: () => import("./app/pages/ProbePopupPage.vue") },
    { path: "/:pathMatch(.*)*", redirect: "/" },
  ],
});

createApp(App).use(router).mount("#app");

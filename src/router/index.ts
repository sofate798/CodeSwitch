import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/home' },
    { path: '/home', component: () => import('../views/Home.vue'), meta: { titleKey: 'nav.home' } },
    { path: '/providers', component: () => import('../views/Providers.vue'), meta: { titleKey: 'nav.providers' } },
    { path: '/snapshots', component: () => import('../views/Snapshots.vue'), meta: { titleKey: 'nav.snapshots' } },
    { path: '/backups', component: () => import('../views/Backups.vue'), meta: { titleKey: 'nav.backups' } },
    { path: '/logs', component: () => import('../views/Logs.vue'), meta: { titleKey: 'nav.logs' } },
    { path: '/settings', component: () => import('../views/Settings.vue'), meta: { titleKey: 'nav.settings' } }
  ]
})

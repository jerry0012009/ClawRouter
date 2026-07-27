import { chromium } from '/tmp/acu-playwright.Z2hkzT/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = process.env.ACU_ACCEPTANCE_URL || 'https://eu.jerrypsy.top/acu-router-dev/';
const password = process.env.PROXY_API_KEY;
if (!password) throw new Error('PROXY_API_KEY is required and is never persisted by this script');
const outputDirectory = new URL('../screenshots/', import.meta.url);
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ httpCredentials: { username: 'demo', password }, viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
const allCases = [
  { id: 'avg-code-fix', preset: 1 },
  { id: 'low-json', preset: 0 },
  { id: 'high-reasoning', preset: 3 },
];
const caseFilter = process.env.ACU_ACCEPTANCE_CASE;
const cases = caseFilter ? allCases.filter((item) => item.id === caseFilter) : allCases;
const results = [];

for (const item of cases) {
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('request', (request) => { if (/\/acu\/api\/|\/v1\/chat\/completions/.test(request.url())) calls.push({ method: request.method(), url: request.url() }); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#preset-bar button').nth(item.preset).click();
  await page.locator('#run-btn').click();
  await page.locator('#feedback-row').waitFor({ state: 'visible', timeout: 180_000 });
  await page.waitForFunction(() => window.AcuInteractiveChart?.getState()?.actualModel, null, { timeout: 30_000 });
  const values = await page.evaluate(() => {
    const plan = window.__latestAcuPlan;
    const chart = window.AcuInteractiveChart.getState();
    const text = (id) => document.getElementById(id)?.textContent?.trim() || '';
    return {
      requestId: window.__acuRequestId,
      difficultyScore: plan.difficultyScore,
      judgeStatus: plan.judgeStatus,
      qualityCeilingModel: plan.qualityCeilingModel.modelId,
      qualityCeilingScore: plan.qualityCeilingModel.predictedScore,
      recommendedModel: plan.recommendation.recommended.modelId,
      recommendedScore: plan.recommendation.recommended.predictedScore,
      actualModel: chart.actualModel,
      featuredModels: chart.visibleModelIds,
      featuredView: chart.view,
      baselineMeta: text('baseline-meta'),
      routerMeta: text('router-meta'),
      comparison: text('savings-banner'),
      executionStatus: text('acu-live-application'),
    };
  });
  const callsBeforeInteraction = calls.length;
  if (item.id === 'avg-code-fix') {
    await page.locator('#acu-decision-module').screenshot({ path: new URL('avg-featured.png', outputDirectory).pathname });
    await page.locator('[data-chart-mode="all"]').click();
    await page.waitForTimeout(300);
    const allState = await page.evaluate(() => window.AcuInteractiveChart.getState());
    await page.locator('#acu-decision-module').screenshot({ path: new URL('avg-all-local.png', outputDirectory).pathname });
    const canvas = page.locator('#acu-integrated-chart');
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -300);
      values.wheelZoomView = (await page.evaluate(() => window.AcuInteractiveChart.getState())).view;
      await page.mouse.move(box.x + box.width * .55, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .45, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      values.dragPanView = (await page.evaluate(() => window.AcuInteractiveChart.getState())).view;
      await canvas.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
      values.doubleClickView = (await page.evaluate(() => window.AcuInteractiveChart.getState())).view;
    }
    const ordinary = page.locator('#acu-integrated-legend .acu-model-row').filter({ hasNot: page.locator('i') }).first();
    if (await ordinary.count()) await ordinary.click();
    await page.locator('[data-chart-action="global"]').click();
    await page.waitForTimeout(200);
    await page.locator('#acu-decision-module').screenshot({ path: new URL('avg-all-global.png', outputDirectory).pathname });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-chart-mode="featured"]').click();
    await page.waitForTimeout(200);
    await page.locator('#acu-decision-module').screenshot({ path: new URL('avg-mobile.png', outputDirectory).pathname });
    values.allModels = allState.visibleModelIds;
    values.allView = allState.view;
  }
  const callsAfterInteraction = calls.length;
  results.push({ ...item, ...values, calls, interactionApiCalls: callsAfterInteraction - callsBeforeInteraction, pageErrors: errors });
  await page.close();
}
await browser.close();
const outputName = caseFilter ? `acceptance_interaction_${caseFilter}.json` : 'acceptance_results.json';
await writeFile(new URL(`../${outputName}`, import.meta.url), `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, cases: results }, null, 2)}\n`);

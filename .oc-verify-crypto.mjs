import { chromium } from "playwright";

const symbols = ["BTCUSD", "ETHUSD", "SOLUSD", "BNBUSD", "XRPUSD", "ADAUSD"];
const browser = await chromium.launch({
  headless: true,
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
const cryptoRequests = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("request", (r) => {
  const m = r.url().match(/\/chart\/([A-Z]+-USD)/);
  if (m) cryptoRequests.push(m[1]);
});

await page.goto("https://ndavat.github.io/OpenCharts/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(10000);
const body = await page.locator("body").innerText();
console.log("LIST_NAMES=" + symbols.filter((s) => body.includes(s)).join(","));
console.log("CRYPTO_REQUESTS=" + [...new Set(cryptoRequests)].join(","));

await page.getByRole("button", { name: /AAPL/ }).filter({ visible: true }).first().click();
const input = page.getByPlaceholder("Search symbols...").filter({ visible: true }).first();
await input.fill("BTCUSD");
await page.waitForTimeout(500);
const btcButton = page.getByRole("button", { name: /^BTCUSD\b/ }).filter({ visible: true }).first();
if (await btcButton.count()) {
  await btcButton.click();
  await page.waitForTimeout(6000);
  const chartBody = await page.locator("body").innerText();
  const prices = [...new Set((chartBody.match(/\b\d{2,3},\d{3}\.\d{2}\b/g) ?? []))].slice(0, 4);
  console.log("SELECTED_BTCUSD=" + /BTCUSD/.test(chartBody));
  console.log("BTC_PRICES=" + prices.join(","));
} else {
  console.log("BTCUSD_NOT_IN_PICKER");
}
console.log("CONSOLE_ERRORS=" + errors.length);
for (const e of errors.slice(0, 5)) console.log("ERR=" + e);
await browser.close();

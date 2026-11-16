// BonSwap — a working exchange front-end for the Ammora protocol on GIWA Sepolia.
// Quotes: ALMMClient.quoteExactInput (read-only, straight from chain).
// Swaps:  AmmoraSwapClient.prepareExactIn + execute, signed by the visitor's wallet.
// No private keys anywhere near this file — browser signing only, per the SDK docs.

import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
  type Address,
} from "viem";
import {
  ALMMClient,
  AmmoraSwapClient,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAutoRoutePoolProfiles,
  minOutFromSlippage,
} from "@ammora-protocol/sdk";

const CHAIN_ID = 91342;
// Default: the public GIWA Sepolia RPC (CORS-open). ?rpc=<url> overrides it,
// which is handy for local development behind restrictive networks.
const RPC_URL = new URLSearchParams(location.search).get("rpc") ?? "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const deployment = giwaSepoliaAutoRouteDeployment;
const lmm = deployment.contracts.liquidityMarketMaker;

const chain = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Sepolia Explorer", url: EXPLORER } },
});

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

// Every ALMM bin pool created on GIWA Sepolia, from the factory's PoolCreated logs
// (factory 0x63c9f1cab865d708a49df5304b59e91474860bde). Symbols are read live below.
const POOL_ADDRESSES: Address[] = [
  "0xb08f67e162797635fca6a9670a1f39503bbc0a46", // AGC / WETH
  "0x15e5c425609aecfcc9aaf7bb26ca13a3b3341ac8", // WETH / AV4E2E
  "0x437f790914e704a939f7e2da29f138e5c664d2c0", // VDRL / WETH
  "0x23c3699e29542cb21095799b8dcf01fa8f55a015", // WETH / AGCP
  "0x0033f1b96713f0bbef0da0ec21a556900a0a1822", // AGCP / BKB8129
  "0x783d134200169ed71b5b4b4cd6ab6588811cc21e", // TEST / AGCP
  "0x6864015cf35f5314a2170c0c4e002ea858d75b1b", // ATBTC / AEUR
  "0xb0c823135ed4768ab108040e7ef244a369d69270", // TUSD18 / TUSD6
];

type TokenInfo = { address: Address; symbol: string; decimals: number };
type PoolInfo = {
  address: Address;
  base: TokenInfo;
  quote: TokenInfo;
  binStepBps: number;
  feeBps: number;
  client: ALMMClient;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const poolSel = $("poolSel") as unknown as HTMLSelectElement;
const inSel = $("inSel") as unknown as HTMLSelectElement;
const outSel = $("outSel") as unknown as HTMLSelectElement;
const inAmt = $("inAmt") as unknown as HTMLInputElement;
const outAmt = $("outAmt") as unknown as HTMLInputElement;
const inBal = $("inBal");
const outBal = $("outBal");
const qRate = $("qRate");
const qMin = $("qMin");
const qFee = $("qFee");
const qBin = $("qBin");
const qWarn = $("qWarn");
const statusEl = $("status");
const swapBtn = $("swapBtn") as unknown as HTMLButtonElement;
const connectBtn = $("connectBtn") as unknown as HTMLButtonElement;
const poolRows = $("poolRows");

let pools: PoolInfo[] = [];
let pool: PoolInfo | null = null;
let slippageBps = 50;
let account: Address | null = null;
let swapClient: AmmoraSwapClient | null = null;
let quoteSeq = 0;

function fmt(raw: bigint, decimals: number, maxFrac = 10): string {
  const s = formatUnits(raw, decimals);
  const [i, f = ""] = s.split(".");
  const trimmed = f.slice(0, maxFrac).replace(/0+$/, "");
  const out = trimmed ? `${i}.${trimmed}` : i;
  // Canary testnet pools trade in dust: never render a real amount as "0".
  if (out === "0" && raw > 0n) return s;
  return out;
}

function setStatus(html: string) {
  statusEl.innerHTML = html;
}

async function tokenInfo(address: Address): Promise<TokenInfo> {
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { address, symbol, decimals: Number(decimals) };
}

async function loadPools() {
  const loaded: PoolInfo[] = [];
  for (const address of POOL_ADDRESSES) {
    try {
      const client = new ALMMClient(publicClient, address, lmm.positionManager, lmm.binLens, {});
      const state = await client.getPoolState();
      const [base, quote] = await Promise.all([tokenInfo(state.baseToken), tokenInfo(state.quoteToken)]);
      loaded.push({
        address,
        base,
        quote,
        binStepBps: Number(state.binStepBps),
        feeBps: Number(state.currentFeeBps),
        client,
      });
    } catch {
      // A pool that does not answer as a bin pool is simply left out.
    }
  }
  pools = loaded;
  poolSel.innerHTML = pools
    .map((p, i) => `<option value="${i}">${p.base.symbol} / ${p.quote.symbol} · step ${p.binStepBps}bps</option>`)
    .join("");
  renderPoolTable();
  selectPool(0);
}

function renderPoolTable() {
  poolRows.innerHTML = pools
    .map(
      (p, i) => `<tr class="pick" data-i="${i}">
        <td><b>${p.base.symbol} / ${p.quote.symbol}</b><br><span class="pill">bin step ${p.binStepBps} bps</span></td>
        <td id="ref-${i}"><span class="spin"></span></td>
        <td>${(p.feeBps / 100).toFixed(2)}%</td>
        <td><a class="mono" href="${EXPLORER}/address/${p.address}" target="_blank" rel="noopener">${p.address.slice(0, 10)}…${p.address.slice(-6)}</a></td>
      </tr>`,
    )
    .join("");
  poolRows.querySelectorAll("tr.pick").forEach((tr) => {
    tr.addEventListener("click", () => {
      const i = Number((tr as HTMLElement).dataset.i);
      poolSel.value = String(i);
      selectPool(i);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
  pools.forEach(async (p, i) => {
    const cell = document.getElementById(`ref-${i}`);
    if (!cell) return;
    try {
      const q = await p.client.quoteExactInput(parseUnits("1", p.base.decimals), true);
      cell.textContent =
        q.amountOut > 0n
          ? `1 ${p.base.symbol} → ${fmt(q.amountOut, p.quote.decimals)} ${p.quote.symbol}${q.amountInLeft > 0n ? " (partial)" : ""}`
          : "no liquidity in range";
    } catch {
      cell.textContent = "quote unavailable";
    }
  });
}

function selectPool(i: number) {
  pool = pools[i] ?? null;
  document.querySelectorAll("tr.pick").forEach((tr, j) => tr.classList.toggle("sel", j === i));
  if (!pool) return;
  const opts = (sel: HTMLSelectElement, first: TokenInfo, second: TokenInfo) => {
    sel.innerHTML = `<option value="${first.address}">${first.symbol}</option><option value="${second.address}">${second.symbol}</option>`;
  };
  opts(inSel, pool.base, pool.quote);
  opts(outSel, pool.quote, pool.base);
  qFee.textContent = `${(pool.feeBps / 100).toFixed(2)}%`;
  qBin.textContent = `${pool.binStepBps} bps`;
  refreshBalances();
  refreshQuote();
}

function direction(): { tokenIn: TokenInfo; tokenOut: TokenInfo; baseForQuote: boolean } {
  const inAddr = inSel.value as Address;
  const baseForQuote = pool!.base.address.toLowerCase() === inAddr.toLowerCase();
  return {
    tokenIn: baseForQuote ? pool!.base : pool!.quote,
    tokenOut: baseForQuote ? pool!.quote : pool!.base,
    baseForQuote,
  };
}

async function refreshBalances() {
  if (!pool) return;
  if (!account) {
    inBal.textContent = "";
    outBal.textContent = "";
    return;
  }
  const { tokenIn, tokenOut } = direction();
  const [bIn, bOut] = await Promise.all([
    publicClient.readContract({ address: tokenIn.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
    publicClient.readContract({ address: tokenOut.address, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
  ]);
  inBal.textContent = `Balance: ${fmt(bIn, tokenIn.decimals)} ${tokenIn.symbol}`;
  outBal.textContent = `Balance: ${fmt(bOut, tokenOut.decimals)} ${tokenOut.symbol}`;
}

let lastQuote: { amountOut: bigint; amountInLeft: bigint } | null = null;

async function refreshQuote() {
  if (!pool) return;
  const seq = ++quoteSeq;
  const { tokenIn, tokenOut, baseForQuote } = direction();
  const raw = inAmt.value.trim();
  lastQuote = null;
  if (!raw || Number(raw) <= 0) {
    outAmt.value = "";
    qRate.textContent = "—";
    qMin.textContent = "—";
    qWarn.textContent = "";
    updateSwapButton();
    return;
  }
  let amountIn: bigint;
  try {
    amountIn = parseUnits(raw as `${number}`, tokenIn.decimals);
  } catch {
    qWarn.textContent = "Amount has too many decimal places for this token.";
    updateSwapButton();
    return;
  }
  qRate.innerHTML = '<span class="spin"></span>';
  try {
    const q = await pool.client.quoteExactInput(amountIn, baseForQuote);
    if (seq !== quoteSeq) return; // a newer quote is on its way
    lastQuote = q;
    outAmt.value = q.amountOut > 0n ? fmt(q.amountOut, tokenOut.decimals) : "0";
    const filled = amountIn - q.amountInLeft;
    qRate.textContent =
      q.amountOut > 0n && filled > 0n
        ? `1 ${tokenIn.symbol} ≈ ${fmt((q.amountOut * 10n ** BigInt(tokenIn.decimals)) / filled, tokenOut.decimals)} ${tokenOut.symbol}`
        : "—";
    const min = q.amountOut > 0n ? minOutFromSlippage(q.amountOut, BigInt(slippageBps)) : 0n;
    qMin.textContent = q.amountOut > 0n ? `${fmt(min, tokenOut.decimals)} ${tokenOut.symbol}` : "—";
    qWarn.textContent =
      q.amountOut === 0n
        ? "This pool has no liquidity in range for that direction right now — try another pool or direction."
        : q.amountInLeft > 0n
          ? `Pool can only fill part of this amount: ${fmt(q.amountInLeft, tokenIn.decimals)} ${tokenIn.symbol} would be left unfilled. Lower the amount.`
          : "";
  } catch (e) {
    if (seq !== quoteSeq) return;
    qWarn.textContent = `Quote failed: ${e instanceof Error ? e.message.slice(0, 140) : String(e)}`;
  }
  updateSwapButton();
}

function updateSwapButton() {
  if (!account) {
    swapBtn.disabled = true;
    swapBtn.textContent = "Connect wallet to swap";
  } else if (!lastQuote || lastQuote.amountOut === 0n) {
    swapBtn.disabled = true;
    swapBtn.textContent = "Enter an amount";
  } else if (lastQuote.amountInLeft > 0n) {
    swapBtn.disabled = true;
    swapBtn.textContent = "Amount too large for this pool";
  } else {
    swapBtn.disabled = false;
    swapBtn.textContent = "Swap";
  }
}

// ---------- wallet ----------

function ethereum() {
  const eth = (window as unknown as { ethereum?: unknown }).ethereum;
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or another EVM wallet) and reload.");
  return eth as never;
}

async function ensureChain() {
  const eth = ethereum() as { request: (a: { method: string; params?: unknown }) => Promise<unknown> };
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (parseInt(current, 16) === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x164CE" }] });
  } catch {
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x164CE",
          chainName: "GIWA Sepolia",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER],
        },
      ],
    });
  }
}

async function connect() {
  try {
    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting…";
    await ensureChain();
    const wallet = createWalletClient({ chain, transport: custom(ethereum()) });
    const [addr] = await wallet.requestAddresses();
    account = addr;
    connectBtn.textContent = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    setStatus(`<span class="ok">Wallet connected on GIWA Sepolia.</span>`);
    refreshBalances();
    updateSwapButton();
  } catch (e) {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect Wallet";
    setStatus(`<span class="err">${e instanceof Error ? e.message.slice(0, 200) : String(e)}</span>`);
  }
}

async function doSwap() {
  if (!pool || !account || !lastQuote) return;
  const { tokenIn, baseForQuote } = direction();
  void baseForQuote;
  const amountIn = parseUnits(inAmt.value.trim() as `${number}`, tokenIn.decimals);
  try {
    swapBtn.disabled = true;
    setStatus('<span class="spin"></span> Preparing swap with the Ammora SDK…');
    if (!swapClient) {
      swapClient = await AmmoraSwapClient.create(publicClient, {
        deploymentCatalog: { [CHAIN_ID]: deployment },
        factoryProfiles: giwaSepoliaAutoRoutePoolProfiles,
      });
    }
    const prepared = await swapClient.prepareExactIn({
      model: "almm",
      pool: pool.address,
      tokenIn: tokenIn.address,
      inputAsset: "erc20",
      amountIn,
      payer: account,
      recipient: account,
      slippageBps,
      executionMode: "direct-wallet",
    });
    const wallet = createWalletClient({ account, chain, transport: custom(ethereum()) });
    setStatus('<span class="spin"></span> Confirm the swap in your wallet…');
    const result = await prepared.execute(wallet, {
      onStatus: (s) => setStatus(`<span class="spin"></span> ${JSON.stringify(s).slice(0, 160)}`),
    });
    setStatus(
      `<span class="ok">Swap done.</span> Received ${result.amountReceived !== null ? fmt(result.amountReceived, direction().tokenOut.decimals) + " " + direction().tokenOut.symbol : "(see explorer)"}. ` +
        `<a href="${EXPLORER}/tx/${result.hash}" target="_blank" rel="noopener">View transaction</a>`,
    );
    refreshBalances();
    refreshQuote();
  } catch (e) {
    setStatus(`<span class="err">Swap failed: ${e instanceof Error ? e.message.slice(0, 220) : String(e)}</span>`);
  } finally {
    updateSwapButton();
  }
}

// ---------- wiring ----------

poolSel.addEventListener("change", () => selectPool(Number(poolSel.value)));
inSel.addEventListener("change", () => {
  outSel.value = inSel.value === pool!.base.address ? pool!.quote.address : pool!.base.address;
  refreshBalances();
  refreshQuote();
});
outSel.addEventListener("change", () => {
  inSel.value = outSel.value === pool!.base.address ? pool!.quote.address : pool!.base.address;
  refreshBalances();
  refreshQuote();
});
$("flipBtn").addEventListener("click", () => {
  const v = inSel.value;
  inSel.value = outSel.value;
  outSel.value = v;
  inAmt.value = "";
  refreshBalances();
  refreshQuote();
});
let debounce: ReturnType<typeof setTimeout> | undefined;
inAmt.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(refreshQuote, 500);
});
$("slipRow").querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    $("slipRow").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
    b.classList.add("on");
    slippageBps = Number((b as HTMLElement).dataset.bps);
    refreshQuote();
  });
});
connectBtn.addEventListener("click", connect);
swapBtn.addEventListener("click", doSwap);

loadPools().catch((e) => {
  poolRows.innerHTML = `<tr><td colspan="4">Could not reach the GIWA Sepolia RPC: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}</td></tr>`;
});

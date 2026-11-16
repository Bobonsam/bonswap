# BonSwap

A working token exchange on **GIWA Sepolia** (chain 91342), built with the
**Ammora SDK** (`@ammora-protocol/sdk@0.3.9`) for the Ammora Builder Mission.

**Live site:** https://bobonsam.github.io/bonswap/

## What it does

- Lists every Ammora **ALMM bin pool** created on GIWA Sepolia — discovered
  from the ALMM factory's on-chain `PoolCreated` events, with token symbols,
  fees and reference quotes read live from chain.
- **Live quotes** for any pool and direction via `ALMMClient.quoteExactInput`,
  with minimum-received computed from the chosen slippage tolerance and
  honest partial-fill / no-liquidity warnings (testnet canary pools are thin).
- **Real swaps**: `AmmoraSwapClient.prepareExactIn` (model `almm`,
  direct-wallet execution) plans the swap — approval, minimum output and
  deadline included — and the visitor's own browser wallet signs it.
  No private keys in the code, ever.

## Run it locally

```bash
npm install
node build.mjs        # bundles src/main.ts with esbuild into dist/
npx serve dist        # or any static file server
```

Open the page, connect a wallet on GIWA Sepolia, pick a pool and swap.
Behind a network that cannot reach the public RPC directly, append
`?rpc=<your-rpc-or-relay-url>` to the page URL.

## Stack

- `@ammora-protocol/sdk` 0.3.9 + `viem` for chain access
- Plain TypeScript bundled with esbuild — no framework
- Static hosting (GitHub Pages, `gh-pages` branch)

## Notes

Testnet only — the tokens are canary/test assets with no real value.
Not financial advice.

Built by [Bobonsam](https://github.com/Bobonsam) · Ammora: https://ammora.org

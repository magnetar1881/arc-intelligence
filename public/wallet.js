// ========================
// WALLET CONNECTION
// ========================
let connectedWallet = null;

const ARC_MAINNET = {
  chainId: "0x13B2", // 5042
  chainName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.arc.io"],
  blockExplorerUrls: ["https://explorer.arc.io"]
};

async function ensureArcMainnet() {
  const current = await window.ethereum.request({ method: "eth_chainId" });
  if (current && parseInt(current, 16) === 5042) return;
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: ARC_MAINNET.chainId }]
    });
  } catch (e) {
    if (e.code === 4902 || String(e.message || "").includes("Unrecognized chain")) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [ARC_MAINNET]
      });
    } else {
      throw e;
    }
  }
}

async function connectWallet() {
  if (typeof window.ethereum === "undefined") {
    alert("MetaMask bulunamadı. Lütfen MetaMask yükleyin: https://metamask.io");
    return null;
  }

  try {
    await ensureArcMainnet();

    const accounts = await window.ethereum.request({
      method: "eth_requestAccounts"
    });

    connectedWallet = accounts[0];
    if (typeof refreshBal === "function") refreshBal();
    window.connectedWallet = connectedWallet;
    updateWalletUI(connectedWallet);

    // Hesap değişince güncelle
    window.ethereum.on("accountsChanged", (accounts) => {
      connectedWallet = accounts[0] || null;
      window.connectedWallet = connectedWallet;
      updateWalletUI(connectedWallet);

      if (typeof refreshBal === "function") {
        refreshBal();
      }
    });
    window.ethereum.on("chainChanged", () => {
      ensureArcMainnet().catch(() => {});
    });

    return connectedWallet;
  } catch (e) {
    console.log('Wallet connect error:', e.message);
    return null;
  }
}

function disconnectWallet() {
  connectedWallet = null;
  updateWalletUI(null);
}

function updateWalletUI(address) {
  const btn = document.getElementById('wallet-btn');
  if (!btn) return;

  if (address) {
    btn.textContent = address.slice(0, 6) + '...' + address.slice(-4);
    btn.style.background = 'rgba(16,185,129,.12)';
    btn.style.borderColor = 'rgba(16,185,129,.3)';
    btn.style.color = '#10b981';
    btn.onclick = disconnectWallet;
  } else {
    btn.textContent = 'Connect Wallet';
    btn.style.background = 'transparent';
    btn.style.borderColor = 'rgba(59,130,246,.3)';
    btn.style.color = '#60a5fa';
    btn.onclick = connectWallet;
  }
}

// Sayfa açılınca bağlı cüzdan var mı kontrol et
async function checkExistingConnection() {
  if (typeof window.ethereum === 'undefined') return;
  try {
    const accounts = await window.ethereum.request({
      method: 'eth_accounts'
    });
    if (accounts.length > 0) {
      connectedWallet = accounts[0];
      updateWalletUI(connectedWallet);
    }
  } catch (e) {}
}

document.addEventListener('DOMContentLoaded', checkExistingConnection);

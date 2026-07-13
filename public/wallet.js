// ========================
// WALLET CONNECTION
// ========================
let connectedWallet = null;

async function connectWallet() {
  if (typeof window.ethereum === 'undefined') {
    alert('MetaMask bulunamadı. Lütfen MetaMask yükleyin: https://metamask.io');
    return null;
  }

  try {
    const accounts = await window.ethereum.request({
      method: 'eth_requestAccounts'
    });

    connectedWallet = accounts[0];
    updateWalletUI(connectedWallet);

    // Hesap değişince güncelle
    window.ethereum.on('accountsChanged', (accounts) => {
      connectedWallet = accounts[0] || null;
      updateWalletUI(connectedWallet);
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

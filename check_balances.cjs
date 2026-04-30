const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
const USDC_ADDR = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
const usdcContract = new ethers.Contract(USDC_ADDR, USDC_ABI, provider);

const proxyWallet = '0x8F7997DaE506b36c1F70bA518F8fD7bF33E1A267';
const ownerWallet = '0xBb0cA7CE98c971e4a7b4637aD6ceD0c0e909Bca0';

async function check() {
  const proxyBal = await usdcContract.balanceOf(proxyWallet);
  const ownerBal = await usdcContract.balanceOf(ownerWallet);
  console.log('USDC on Proxy L1 (0x8F79...):', ethers.formatUnits(proxyBal, 6));
  console.log('USDC on Owner (0xBb0c...):', ethers.formatUnits(ownerBal, 6));
}
check();

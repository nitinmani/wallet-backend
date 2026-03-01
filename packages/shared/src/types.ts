export type WalletType = "STANDARD" | "GROUPED";
export type TxType = "DEPOSIT" | "WITHDRAWAL" | "INTERNAL";
export type TxStatus = "PENDING" | "BROADCASTING" | "CONFIRMED" | "FAILED";

export interface UserResponse {
  id: string;
  email: string;
  apiKey: string;
  createdAt: string;
}

export interface WalletResponse {
  id: string;
  name: string;
  address: string;
  type: WalletType;
  walletGroupId: string | null;
  ownerId: string;
  balance: string;
  createdAt: string;
  walletGroup?: {
    id: string;
    name: string;
  } | null;
  accesses?: Array<{
    user: {
      id: string;
      email: string;
    };
  }>;
}

export interface TransactionResponse {
  id: string;
  walletId: string;
  type: TxType;
  to: string | null;
  from: string | null;
  amount: string;
  txHash: string | null;
  status: TxStatus;
  createdAt: string;
}

export interface BalanceResponse {
  address: string;
  balance: string;
  formatted: string;
}

export interface SignatureResponse {
  signature: string;
  message: string;
  address: string;
}

export interface SendTxRequest {
  to: string;
  amount: string;
}

export interface InternalTransferRequest {
  toWalletId: string;
  amount: string;
}

export interface SignMessageRequest {
  message: string;
}

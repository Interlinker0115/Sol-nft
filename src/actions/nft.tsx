import {
  Attribute,
  createAssociatedTokenAccountInstruction,
  createMint,
  createMetadata,
  updateMetadata,
  createMasterEdition,
  Data,
  Creator,
} from "./"
import {
  programIds,
  notify,
  findProgramAddress,
  StringPublicKey,
  toPublicKey,
  getAssetCostToStore,
  ARWEAVE_UPLOAD_ENDPOINT,
  authApiRequest,
} from "../utils"
import { ENV, sendTransactionWithRetry } from "../contexts"
import { sendTransaction } from "../contexts"
import { ADD_MINT_URL } from "../constants/urls"

import { WalletSigner } from "../contexts/wallet0"

import React, { Dispatch, SetStateAction } from "react"
import { MintLayout, Token } from "@solana/spl-token"
import {
  Keypair,
  Connection,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js"
import crypto from "crypto"

import { AR_SOL_HOLDER_ID } from "../utils/ids"
import BN from "bn.js"

const RESERVED_TXN_MANIFEST = "manifest.json"
const RESERVED_METADATA = "metadata.json"

interface IArweaveResult {
  error?: string
  messages?: Array<{
    filename: string
    status: "success" | "fail"
    transactionId?: string
    error?: string
  }>
}

const uploadToArweave = async (data: FormData): Promise<IArweaveResult> => {
  const resp = await fetch(ARWEAVE_UPLOAD_ENDPOINT, {
    method: "POST",
    // @ts-ignore
    body: data,
  })

  if (!resp.ok) {
    return Promise.reject(
      new Error(
        "Unable to upload the artwork to Arweave. Please wait and then try again."
      )
    )
  }

  const result: IArweaveResult = await resp.json()

  if (result.error) {
    return Promise.reject(new Error(result.error))
  }

  return result
}

export const mintNFT = async (
  connection: Connection,
  wallet: WalletSigner | undefined | any,
  env: ENV,
  files: File[],
  metadata: {
    name: string
    symbol: string
    description: string
    image: string | undefined
    animation_url: string | undefined
    attributes: Attribute[] | undefined
    external_url: string
    properties: any
    creators: Creator[] | null
    sellerFeeBasisPoints: number
  },
  progressCallback: Dispatch<SetStateAction<number>>,
  maxSupply?: number
): Promise<{
  metadataAccount: any
} | void> => {
  if (!wallet?.publicKey) return

  const metadataContent = {
    name: metadata.name,
    symbol: metadata.symbol,
    description: metadata.description,
    seller_fee_basis_points: metadata.sellerFeeBasisPoints,
    image: metadata.image,
    animation_url: metadata.animation_url,
    attributes: metadata.attributes,
    external_url: metadata.external_url,
    properties: {
      ...metadata.properties,
      creators: metadata.creators?.map((creator) => {
        return {
          address: creator.address,
          share: creator.share,
        }
      }),
    },
  }

  const realFiles: File[] = [
    ...files,
    new File([JSON.stringify(metadataContent)], RESERVED_METADATA),
  ]

  const { instructions: pushInstructions, signers: pushSigners } =
    await prepPayForFilesTxn(wallet, realFiles, metadata)

  progressCallback(1)

  const TOKEN_PROGRAM_ID = toPublicKey(programIds().token)

  // Allocate memory for the account
  const mintRent = await connection.getMinimumBalanceForRentExemption(
    MintLayout.span
  )
  // const accountRent = await connection.getMinimumBalanceForRentExemption(
  //   AccountLayout.span,
  // );

  // This owner is a temporary signer and owner of metadata we use to circumvent requesting signing
  // twice post Arweave. We store in an account (payer) and use it post-Arweave to update MD with new link
  // then give control back to the user.
  // const payer = new Account();
  const payerPublicKey = wallet.publicKey.toBase58()
  const instructions: TransactionInstruction[] = [...pushInstructions]
  const signers: Keypair[] = [...pushSigners]

  // This is only temporarily owned by wallet...transferred to program by createMasterEdition below
  const mintKey = createMint(
    instructions,
    wallet.publicKey,
    mintRent,
    0,
    // Some weird bug with phantom where it's public key doesnt mesh with data encode wellff
    toPublicKey(payerPublicKey),
    toPublicKey(payerPublicKey),
    signers
  ).toBase58()

  const recipientKey = (
    await findProgramAddress(
      [
        wallet.publicKey.toBuffer(),
        programIds().token.toBuffer(),
        toPublicKey(mintKey).toBuffer(),
      ],
      programIds().associatedToken
    )
  )[0]

  createAssociatedTokenAccountInstruction(
    instructions,
    toPublicKey(recipientKey),
    wallet.publicKey,
    wallet.publicKey,
    toPublicKey(mintKey)
  )

  const metadataAccount = await createMetadata(
    new Data({
      symbol: metadata.symbol,
      name: metadata.name,
      uri: " ".repeat(64), // size of url for arweave
      sellerFeeBasisPoints: metadata.sellerFeeBasisPoints,
      creators: metadata.creators,
    }),
    payerPublicKey,
    mintKey,
    payerPublicKey,
    instructions,
    wallet.publicKey.toBase58()
  )

  progressCallback(2)

  // TODO: enable when using payer account to avoid 2nd popup
  // const block = await connection.getRecentBlockhash('confirmed');
  // instructions.push(
  //   SystemProgram.transfer({
  //     fromPubkey: wallet.publicKey,
  //     toPubkey: payerPublicKey,
  //     lamports: 0.5 * LAMPORTS_PER_SOL // block.feeCalculator.lamportsPerSignature * 3 + mintRent, // TODO
  //   }),
  // );
  console.log(connection, wallet, instructions, signers)

  const txid = await sendTransaction(
    connection,
    wallet.wallet,
    instructions,
    signers
  )
  progressCallback(3)

  try {
    await connection.confirmTransaction(txid, "max")
    progressCallback(4)
  } catch {
    // ignore
  }

  // Force wait for max confirmations
  // await connection.confirmTransaction(txid, 'max');
  await connection.getParsedConfirmedTransaction(txid, "confirmed")

  progressCallback(5)

  // this means we're done getting AR txn setup. Ship it off to ARWeave!
  const data = new FormData()
  data.append("transaction", txid)
  data.append("env", env)

  const tags = realFiles.reduce(
    (acc: Record<string, Array<{ name: string; value: string }>>, f) => {
      acc[f.name] = [{ name: "mint", value: mintKey }]
      return acc
    },
    {}
  )
  data.append("tags", JSON.stringify(tags))
  realFiles.map((f) => data.append("file[]", f))

  // TODO: convert to absolute file name for image

  const result: IArweaveResult = await uploadToArweave(data)
  progressCallback(6)
  console.log("6", result)

  const metadataFile = result.messages?.find(
    (m) => m.filename === RESERVED_TXN_MANIFEST
  )
  if (metadataFile?.transactionId && wallet.publicKey) {
    const updateInstructions: TransactionInstruction[] = []
    const updateSigners: Keypair[] = []

    // TODO: connect to testnet arweave
    const arweaveLink = `https://arweave.net/${metadataFile.transactionId}`
    await updateMetadata(
      new Data({
        name: metadata.name,
        symbol: metadata.symbol,
        uri: arweaveLink,
        creators: metadata.creators,
        sellerFeeBasisPoints: metadata.sellerFeeBasisPoints,
      }),
      undefined,
      undefined,
      mintKey,
      payerPublicKey,
      updateInstructions,
      metadataAccount
    )

    updateInstructions.push(
      Token.createMintToInstruction(
        TOKEN_PROGRAM_ID,
        toPublicKey(mintKey),
        toPublicKey(recipientKey),
        toPublicKey(payerPublicKey),
        [],
        1
      )
    )
    console.log(updateInstructions)

    progressCallback(7)

    // // In this instruction, mint authority will be removed from the main mint, while
    // // minting authority will be maintained for the Printing mint (which we want.)

    try {
      await createMasterEdition(
        maxSupply !== undefined ? new BN(maxSupply) : undefined,
        mintKey,
        payerPublicKey,
        payerPublicKey,
        payerPublicKey,
        updateInstructions
      )

      progressCallback(8)

      const txid = await sendTransaction(
        connection,
        wallet.wallet,
        updateInstructions,
        updateSigners
      )
      let mint = mintKey
      authApiRequest(ADD_MINT_URL, { mint }, "POST", "application/json", wallet)

      return { metadataAccount }
    } catch (error) {
      console.log(error)
    }

    // TODO: enable when using payer account to avoid 2nd popup
    /*  if (maxSupply !== undefined)
      updateInstructions.push(
        setAuthority({
          target: authTokenAccount,
          currentAuthority: payerPublicKey,
          newAuthority: wallet.publicKey,
          authorityType: 'AccountOwner',
        }),
      );
*/
    // TODO: enable when using payer account to avoid 2nd popup
    // Note with refactoring this needs to switch to the updateMetadataAccount command
    // await transferUpdateAuthority(
    //   metadataAccount,
    //   payerPublicKey,
    //   wallet.publicKey,
    //   updateInstructions,
    // );

    {
      /**  notify({
      message: 'Art created on Solana',
      description: (
        <a href={arweaveLink} target="_blank" rel="noopener noreferrer">
          Arweave Link
        </a>
      ),
      type: 'success',
    });
*/
    }
    // TODO: refund funds

    // send transfer back to user
  }
  // TODO:
  // 1. Jordan: --- upload file and metadata to storage API
  // 2. pay for storage by hashing files and attaching memo for each file
}

export const prepPayForFilesTxn = async (
  wallet: WalletSigner | any,
  files: File[],
  metadata: any
): Promise<{
  instructions: TransactionInstruction[]
  signers: Keypair[]
}> => {
  const memo = programIds().memo

  const instructions: TransactionInstruction[] = []
  const signers: Keypair[] = []

  if (wallet.publicKey)
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: AR_SOL_HOLDER_ID,
        lamports: await getAssetCostToStore(files),
      })
    )

  for (let i = 0; i < files.length; i++) {
    const hashSum = crypto.createHash("sha256")
    hashSum.update(await files[i].text())
    const hex = hashSum.digest("hex")
    instructions.push(
      new TransactionInstruction({
        keys: [],
        programId: memo,
        data: Buffer.from(hex),
      })
    )
  }

  return {
    instructions,
    signers,
  }
}

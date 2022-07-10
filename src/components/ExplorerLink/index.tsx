import React from "react";
import { shortenAddress } from "../../utils/utils";
import { PublicKey } from "@solana/web3.js";

export const ExplorerLink = (props: {
  address: string | PublicKey;
  type: string;
  code?: boolean;
  style?: React.CSSProperties;
  length?: number;
}) => {
  const { type, code } = props;

  const address =
    typeof props.address === "string"
      ? props.address
      : props.address?.toBase58();

  if (!address) {
    return null;
  }

  const length = props.length ?? 9;

  return (
    <a
      href={`https://explorer.solana.com/${type}/${address}`}
      // eslint-disable-next-line react/jsx-no-target-blank
      target="_blank"
      title={address}
      style={props.style}
      rel="noreferrer"
    >
      {code ? (
        <span style={props.style}>{shortenAddress(address, length)}</span>
      ) : (
        shortenAddress(address, length)
      )}
    </a>
  );
};

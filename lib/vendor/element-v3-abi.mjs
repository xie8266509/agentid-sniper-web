// Minimal unmodified ABI entries from element-market/element-js-sdk.
// Commit 538b1bb613b45989a308d0d95cb68804bb2dc47b; MIT, see element-sdk-LICENSE.
// https://github.com/element-market/element-js-sdk/blob/538b1bb613b45989a308d0d95cb68804bb2dc47b/src/contracts/abi/elementEx/IElementEx.json
export const ELEMENT_ABI = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "taker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "contract IERC20",
        "name": "erc20Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc20FillAmount",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          }
        ],
        "indexed": false,
        "internalType": "struct INFTOrdersFeature.Fee[]",
        "name": "fees",
        "type": "tuple[]"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "erc1155Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc1155TokenId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "erc1155FillAmount",
        "type": "uint128"
      }
    ],
    "name": "ERC1155BuyOrderFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      }
    ],
    "name": "ERC1155OrderCancelled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "taker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "contract IERC20",
        "name": "erc20Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc20FillAmount",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          }
        ],
        "indexed": false,
        "internalType": "struct INFTOrdersFeature.Fee[]",
        "name": "fees",
        "type": "tuple[]"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "erc1155Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc1155TokenId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint128",
        "name": "erc1155FillAmount",
        "type": "uint128"
      }
    ],
    "name": "ERC1155SellOrderFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "taker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "contract IERC20",
        "name": "erc20Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc20TokenAmount",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          }
        ],
        "indexed": false,
        "internalType": "struct INFTOrdersFeature.Fee[]",
        "name": "fees",
        "type": "tuple[]"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "erc721Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc721TokenId",
        "type": "uint256"
      }
    ],
    "name": "ERC721BuyOrderFilled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      }
    ],
    "name": "ERC721OrderCancelled",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "maker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "taker",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "nonce",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "contract IERC20",
        "name": "erc20Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc20TokenAmount",
        "type": "uint256"
      },
      {
        "components": [
          {
            "internalType": "address",
            "name": "recipient",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amount",
            "type": "uint256"
          }
        ],
        "indexed": false,
        "internalType": "struct INFTOrdersFeature.Fee[]",
        "name": "fees",
        "type": "tuple[]"
      },
      {
        "indexed": false,
        "internalType": "address",
        "name": "erc721Token",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "erc721TokenId",
        "type": "uint256"
      }
    ],
    "name": "ERC721SellOrderFilled",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "orderNonce",
        "type": "uint256"
      }
    ],
    "name": "cancelERC1155Order",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "orderNonce",
        "type": "uint256"
      }
    ],
    "name": "cancelERC721Order",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "erc1155TokenProperties",
            "type": "tuple[]"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155BuyOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC1155BuyOrderHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "erc1155TokenProperties",
            "type": "tuple[]"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155BuyOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC1155BuyOrderInfo",
    "outputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "orderHash",
            "type": "bytes32"
          },
          {
            "internalType": "enum LibNFTOrder.OrderStatus",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "orderAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "remainingAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.OrderInfo",
        "name": "orderInfo",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155SellOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC1155SellOrderHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "orderHash",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155SellOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC1155SellOrderInfo",
    "outputs": [
      {
        "components": [
          {
            "internalType": "bytes32",
            "name": "orderHash",
            "type": "bytes32"
          },
          {
            "internalType": "enum LibNFTOrder.OrderStatus",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "uint128",
            "name": "orderAmount",
            "type": "uint128"
          },
          {
            "internalType": "uint128",
            "name": "remainingAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.OrderInfo",
        "name": "orderInfo",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "nftProperties",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTBuyOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC721BuyOrderHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "nftProperties",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTBuyOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC721BuyOrderStatus",
    "outputs": [
      {
        "internalType": "enum LibNFTOrder.OrderStatus",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTSellOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC721SellOrderHash",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTSellOrder",
        "name": "order",
        "type": "tuple"
      }
    ],
    "name": "getERC721SellOrderStatus",
    "outputs": [
      {
        "internalType": "enum LibNFTOrder.OrderStatus",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "maker",
        "type": "address"
      }
    ],
    "name": "getHashNonce",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "erc1155TokenProperties",
            "type": "tuple[]"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155BuyOrder",
        "name": "buyOrder",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint256",
        "name": "erc1155TokenId",
        "type": "uint256"
      },
      {
        "internalType": "uint128",
        "name": "erc1155SellAmount",
        "type": "uint128"
      },
      {
        "internalType": "bool",
        "name": "unwrapNativeToken",
        "type": "bool"
      },
      {
        "internalType": "bytes",
        "name": "takerData",
        "type": "bytes"
      }
    ],
    "name": "sellERC1155",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "nftProperties",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTBuyOrder",
        "name": "buyOrder",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      },
      {
        "internalType": "uint256",
        "name": "erc721TokenId",
        "type": "uint256"
      },
      {
        "internalType": "bool",
        "name": "unwrapNativeToken",
        "type": "bool"
      },
      {
        "internalType": "bytes",
        "name": "takerData",
        "type": "bytes"
      }
    ],
    "name": "sellERC721",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "erc1155Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc1155TokenId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "erc1155TokenProperties",
            "type": "tuple[]"
          },
          {
            "internalType": "uint128",
            "name": "erc1155TokenAmount",
            "type": "uint128"
          }
        ],
        "internalType": "struct LibNFTOrder.ERC1155BuyOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      }
    ],
    "name": "validateERC1155BuyOrderSignature",
    "outputs": [],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "maker",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "taker",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "expiry",
            "type": "uint256"
          },
          {
            "internalType": "uint256",
            "name": "nonce",
            "type": "uint256"
          },
          {
            "internalType": "contract IERC20",
            "name": "erc20Token",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "erc20TokenAmount",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "address",
                "name": "recipient",
                "type": "address"
              },
              {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
              },
              {
                "internalType": "bytes",
                "name": "feeData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Fee[]",
            "name": "fees",
            "type": "tuple[]"
          },
          {
            "internalType": "address",
            "name": "nft",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "nftId",
            "type": "uint256"
          },
          {
            "components": [
              {
                "internalType": "contract IPropertyValidator",
                "name": "propertyValidator",
                "type": "address"
              },
              {
                "internalType": "bytes",
                "name": "propertyData",
                "type": "bytes"
              }
            ],
            "internalType": "struct LibNFTOrder.Property[]",
            "name": "nftProperties",
            "type": "tuple[]"
          }
        ],
        "internalType": "struct LibNFTOrder.NFTBuyOrder",
        "name": "order",
        "type": "tuple"
      },
      {
        "components": [
          {
            "internalType": "enum LibSignature.SignatureType",
            "name": "signatureType",
            "type": "uint8"
          },
          {
            "internalType": "uint8",
            "name": "v",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "r",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "s",
            "type": "bytes32"
          }
        ],
        "internalType": "struct LibSignature.Signature",
        "name": "signature",
        "type": "tuple"
      }
    ],
    "name": "validateERC721BuyOrderSignature",
    "outputs": [],
    "stateMutability": "view",
    "type": "function"
  }
];

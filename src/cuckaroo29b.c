
#include <stdint.h>  
#include <stdio.h>
#include "blake2.h"  
#include <unistd.h>
#include <string.h>
#include "portable_endian.h"    // for htole32/64
#include "int-util.h"
#include <emscripten.h>

typedef struct siphash_keys__
{
	uint64_t k0;
	uint64_t k1;
	uint64_t k2;
	uint64_t k3;
} siphash_keys;

static void setsipkeys(const char *keybuf,siphash_keys *keys) {
	keys->k0 = htole64(((uint64_t *)keybuf)[0]);
	keys->k1 = htole64(((uint64_t *)keybuf)[1]);
	keys->k2 = htole64(((uint64_t *)keybuf)[2]);
	keys->k3 = htole64(((uint64_t *)keybuf)[3]);
}
static void setheader(uint8_t *header, const uint32_t headerlen, siphash_keys *keys) {
	char hdrkey[32];
	blake2b((void *)hdrkey, sizeof(hdrkey), (const void *)header, headerlen, 0, 0);
	setsipkeys(hdrkey,keys);
}


// Cuck(ar)oo Cycle, a memory-hard proof-of-work
// Copyright (c) 2013-2019 John Tromp
#define PROOFSIZE 40
#define EDGEBITS 29
#define EDGE_BLOCK_BITS 6
#define EDGE_BLOCK_SIZE (1 << EDGE_BLOCK_BITS)
#define EDGE_BLOCK_MASK (EDGE_BLOCK_SIZE - 1)
#define NEDGES ((uint32_t)1 << EDGEBITS)
#define EDGEMASK ((uint32_t)NEDGES - 1)
static uint64_t v0;
static uint64_t v1;
static uint64_t v2;
static uint64_t v3;
static uint64_t rotl(uint64_t x, uint64_t b) {
	return (x << b) | (x >> (64 - b));
}
static void sip_round() {
	v0 += v1; v2 += v3; v1 = rotl(v1,13);
	v3 = rotl(v3,16); v1 ^= v0; v3 ^= v2;
	v0 = rotl(v0,32); v2 += v1; v0 += v3;
	v1 = rotl(v1,17);   v3 = rotl(v3,21);
	v1 ^= v2; v3 ^= v0; v2 = rotl(v2,32);
}
static void hash24(const uint64_t nonce) {
	v3 ^= nonce;
	sip_round(); sip_round();
	v0 ^= nonce;
	v2 ^= 0xff;
	sip_round(); sip_round(); sip_round(); sip_round();
}
static uint64_t xor_lanes() {
	return (v0 ^ v1) ^ (v2  ^ v3);
}
static uint64_t sipblock(siphash_keys *keys, const uint32_t edge,uint64_t  *buf) {
	v0=keys->k0;
	v1=keys->k1;
	v2=keys->k2;
	v3=keys->k3;

	uint32_t edge0 = edge & ~EDGE_BLOCK_MASK;
	for (uint32_t i=0; i < EDGE_BLOCK_SIZE; i++) {
		hash24(edge0 + i);
		buf[i] = xor_lanes();
	}
	const uint64_t last = buf[EDGE_BLOCK_MASK];
	for (uint32_t i=0; i < EDGE_BLOCK_MASK; i++)
		buf[i] ^= last;
	return buf[edge & EDGE_BLOCK_MASK];
}
enum verify_code { POW_OK, POW_HEADER_LENGTH, POW_TOO_BIG, POW_TOO_SMALL, POW_NON_MATCHING, POW_BRANCH, POW_DEAD_END, POW_SHORT_CYCLE};
static int verify(uint32_t edges[PROOFSIZE], siphash_keys *keys) {
	uint32_t xor0 = 0, xor1 = 0;
	uint64_t sips[EDGE_BLOCK_SIZE];
	uint32_t uvs[2*PROOFSIZE];

	for (uint32_t n = 0; n < PROOFSIZE; n++) {
		if (edges[n] > EDGEMASK)
			return POW_TOO_BIG;
		if (n && edges[n] <= edges[n-1])
			return POW_TOO_SMALL;
		uint64_t edge = sipblock(keys, edges[n], sips);
		xor0 ^= uvs[2*n  ] = edge & EDGEMASK;
		xor1 ^= uvs[2*n+1] = (edge >> 32) & EDGEMASK;
		}
	if (xor0 | xor1)              // optional check for obviously bad proofs
		return POW_NON_MATCHING;
	uint32_t n = 0, i = 0, j;
	do {                        // follow cycle
		for (uint32_t k = j = i; (k = (k+2) % (2*PROOFSIZE)) != i; ) {
			if (uvs[k] == uvs[i]) { // find other edge endpoint identical to one at i
				if (j != i)           // already found one before
					return POW_BRANCH;
				j = k;
			}
		}
		if (j == i) return POW_DEAD_END;  // no matching endpoint
		i = j^1;
		n++;
	} while (i != 0);           // must cycle back to start or we would have found branch
	return n == PROOFSIZE ? POW_OK : POW_SHORT_CYCLE;
}

static inline int cadd(uint64_t a, uint64_t b) {
	return a + b < a;
}

static inline int cadc(uint64_t a, uint64_t b, int c) {
	return a + b < a || (c && a + b == (uint64_t) -1);
}

static int check_hash(unsigned char *hash, uint64_t difficulty) {
	uint64_t low, high, top, cur;
	// First check the highest word, this will most likely fail for a random hash.
	top = mul128(swap64le(((const uint64_t *) hash)[3]), difficulty, &high);
	if (high != 0) {
		return 0;
	}
	low = mul128(swap64le(((const uint64_t *) hash)[0]), difficulty, &cur);
	low = mul128(swap64le(((const uint64_t *) hash)[1]), difficulty, &high);
	int carry = cadd(cur, low);
	cur = high;
	low = mul128(swap64le(((const uint64_t *) hash)[2]), difficulty, &high);
	carry = cadc(cur, low, carry);
	carry = cadc(high, top, carry);
	return !carry;
}

EMSCRIPTEN_KEEPALIVE
int c29b_verify(uint8_t *header,int32_t len,uint32_t *cycle) {
	
	siphash_keys keys;
	setheader(header,len,&keys);

	uint32_t edges[PROOFSIZE];
	
	for (int i=0; i<PROOFSIZE; i++)
		edges[i] = cycle[i];

	return verify(cycle,&keys);
}

EMSCRIPTEN_KEEPALIVE
int check_diff(uint32_t diff, uint32_t *cycle) {
	
	uint8_t hashdata[116]; // PROOFSIZE*EDGEBITS/8
	memset(hashdata, 0, 116);

	int bytepos = 0;
	int bitpos = 0;
	for(int i = 0; i < PROOFSIZE; i++){

		uint32_t node = cycle[i];

		for(int j = 0; j < EDGEBITS; j++) {
			
			if((node >> j) & 1U)
				hashdata[bytepos] |= 1UL << bitpos;

			bitpos++;
			if(bitpos==8) {
				bitpos=0;bytepos++;
			}
		}
	}

	unsigned char cyclehash[32];
	blake2b((void *)cyclehash, sizeof(cyclehash), (const void *)hashdata, sizeof(hashdata), 0, 0);
	
	unsigned char rev_cyclehash[32];
	for(int i = 0; i < 32; i++)
		rev_cyclehash[i] = cyclehash[31-i];
	
	return check_hash(rev_cyclehash,diff);
}


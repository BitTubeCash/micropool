all: c29b_nowasm.js

c29b_nowasm.js:
	emcc cuckaroo29b.c blake2b-ref.c  -o c29b_nowasm.js  -s EXTRA_EXPORTED_RUNTIME_METHODS='["ccall", "cwrap"]' -s WASM=0


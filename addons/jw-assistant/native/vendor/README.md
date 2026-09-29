# JwwHelper_x64.dll

Upstream: [JinkiKeikaku/JwwExchange](https://github.com/JinkiKeikaku/JwwExchange), Unlicense (included).
Binary copied from the locally audited official [PdfToJwwConverter](https://github.com/JinkiKeikaku/PdfToJwwConverter) repository, `PdfToJww/JwwHelper_x64.dll`.
SHA-256: `a2a0c7194d21dd24ed4da0db2e6424766dec9b766ef99bc83d6658ee186513f2`.

Windows x64/.NET Framework native reader, invoked in a bounded child process. The DLL is not served to browsers. Full-file serialization is not used: this prototype patches a uniquely matched line's coordinate bytes and reopens the result before saving. Unsupported/ambiguous records are preserved, not rewritten. No general JWW compatibility guarantee is made.

# Persistent JwwHelper reader (see native/jww-worker.mjs). Loads the DLL and compiles the C# helper once, then serves
# line-delimited JSON on stdin/stdout until stdin closes or {"cmd":"shutdown"} arrives.
#   request : {"id":N,"cmd":"ping"|"read"|"header"|"verify"|"sleep"|"shutdown", ...}
#   response: {"id":N,"ok":true,"result":...} | {"id":N,"ok":false,"error":{"code":"E_...","message":"..."}}
#   first line: {"ready":true,"pid":P,"protocol":1}
# "read" mirrors Read-Jww.ps1 exactly (same JSON shape) and "header" mirrors Write-Jww.ps1 -Mode Header (including the
# PowerShell pipeline flattening of 2-D arrays). "verify" reads a file and returns only the entities whose canonical
# digest differs from the digests sent by Node (plus the ones listed in "full"), so 20k-entity drawings are not shipped.
# ASCII only. Startup failures: stderr `E_JWW_WORKER_START: ...`, exit 1.
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

public static class FrescoJwwWorker {
  static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
  static Assembly Jww;
  static Type ReaderT, CallbackT;
  static readonly Dictionary<Type, PropertyInfo[]> Props = new Dictionary<Type, PropertyInfo[]>();
  static readonly Dictionary<string, PropertyInfo> Named = new Dictionary<string, PropertyInfo>();
  const int EntityLimit = 100000;

  public class Ent { public string Id, Type, Record; public List<KeyValuePair<string, object>> Props = new List<KeyValuePair<string, object>>(); public List<Ent> Components; }
  class Ctx { public int Count, Version; public StringBuilder Diag = new StringBuilder(); public bool FirstDiag = true; }
  public class Collector {
    public Func<object, bool> Fn;
    public bool Add(object o) { return Fn(o); }
  }

  public static void Init(string dll) {
    Jww = Assembly.LoadFrom(dll);
    ReaderT = Jww.GetType("JwwHelper.JwwReader", true);
    CallbackT = Jww.GetType("JwwHelper.JwwDataList+EnumerateShapeCallback", true);
  }
  static PropertyInfo[] PropsOf(Type t) {
    PropertyInfo[] p;
    if (!Props.TryGetValue(t, out p)) {
      var list = new List<PropertyInfo>();
      foreach (var pi in t.GetProperties()) if (pi.Name.StartsWith("m_", StringComparison.OrdinalIgnoreCase)) list.Add(pi);
      p = list.ToArray(); Props[t] = p;
    }
    return p;
  }
  static object Get(object o, string name) {
    var t = o.GetType(); string key = t.FullName + "|" + name; PropertyInfo pi;
    if (!Named.TryGetValue(key, out pi)) { pi = t.GetProperty(name); Named[key] = pi; }
    return pi.GetValue(o, null);
  }

  // ---- JSON writing ------------------------------------------------------------------------------------------------
  static void Num(StringBuilder sb, double d) {
    if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append("null"); return; }
    if (d == 0) { sb.Append('0'); return; } // -0 is written as 0 (as ConvertTo-Json does); digests use the same value
    string r = d.ToString("R", Inv);
    if (double.Parse(r, NumberStyles.Float, Inv) != d) r = d.ToString("G17", Inv);
    sb.Append(r);
  }
  static void Str(StringBuilder sb, string s) {
    if (s == null) { sb.Append("null"); return; }
    sb.Append('"');
    foreach (char c in s) {
      switch (c) {
        case '"': sb.Append("\\\""); break;
        case '\\': sb.Append("\\\\"); break;
        case '\n': sb.Append("\\n"); break;
        case '\r': sb.Append("\\r"); break;
        case '\t': sb.Append("\\t"); break;
        default:
          if (c < 0x20 || (c >= 0xD800 && c <= 0xDFFF) || c == 0x2028 || c == 0x2029) sb.Append("\\u").Append(((int)c).ToString("x4"));
          else sb.Append(c);
          break;
      }
    }
    sb.Append('"');
  }
  static void Value(StringBuilder sb, object v) {
    if (v == null) sb.Append("null");
    else if (v is string) Str(sb, (string)v);
    else if (v is double) Num(sb, (double)v);
    else if (v is float) Num(sb, (float)v);
    else if (v is bool) sb.Append((bool)v ? "true" : "false");
    else sb.Append(Convert.ToString(v, Inv));
  }
  static void Diag(Ctx ctx, string code, string key, string id, string field) {
    if (!ctx.FirstDiag) ctx.Diag.Append(','); ctx.FirstDiag = false;
    ctx.Diag.Append("{\"code\":\"").Append(code).Append("\",\"").Append(key).Append("\":"); Str(ctx.Diag, id);
    if (field != null) { ctx.Diag.Append(",\"field\":"); Str(ctx.Diag, field); }
    ctx.Diag.Append('}');
  }

  // ---- entity conversion (Read-Jww.ps1 Convert-Entity) ----------------------------------------------------------------
  static Ent Convert1(object e, string id, int depth, Ctx ctx) {
    if (depth > 32 || ++ctx.Count > EntityLimit) throw new Exception("E_JWW_ENTITY_LIMIT");
    var t = e.GetType(); string tn = t.Name; var ent = new Ent { Id = id, Type = tn };
    bool ten = tn == "JwwTen" && System.Convert.ToInt32(Get(e, "m_nPenStyle")) != 100;
    bool solid = tn == "JwwSolid" && System.Convert.ToInt32(Get(e, "m_nPenColor")) != 10;
    foreach (var pi in PropsOf(t)) {
      string n = pi.Name;
      if (ten && (n == "m_nCode" || n == "m_radKaitenKaku" || n == "m_dBairitsu")) continue;
      if (solid && n == "m_Color") continue;
      object v = pi.GetValue(e, null);
      if (v is double && (double.IsNaN((double)v) || double.IsInfinity((double)v))) { Diag(ctx, "NONFINITE_FIELD", "entityId", id, n); ent.Props.Add(new KeyValuePair<string, object>(n, null)); }
      else if (v is string || (v is ValueType && !(v is DateTime))) ent.Props.Add(new KeyValuePair<string, object>(n, v));
    }
    if (tn == "JwwSen" && ctx.Version >= 351) {
      using (var ms = new MemoryStream()) using (var w = new BinaryWriter(ms)) {
        w.Write(System.Convert.ToInt32(Get(e, "m_lGroup"))); w.Write(System.Convert.ToByte(Get(e, "m_nPenStyle")));
        foreach (var p in new[] { "m_nPenColor", "m_nPenWidth", "m_nLayer", "m_nGLayer", "m_sFlg" }) w.Write(System.Convert.ToInt16(Get(e, p)));
        foreach (var p in new[] { "m_start_x", "m_start_y", "m_end_x", "m_end_y" }) w.Write((double)Get(e, p));
        w.Flush(); ent.Record = System.Convert.ToBase64String(ms.ToArray());
      }
    }
    if (tn == "JwwSunpou") {
      ent.Components = new List<Ent> { Convert1(Get(e, "m_Sen"), id + "/line", depth + 1, ctx), Convert1(Get(e, "m_Moji"), id + "/text", depth + 1, ctx) };
      Diag(ctx, "DIMENSION_AUXILIARY_UNAVAILABLE", "entityId", id, null);
    }
    return ent;
  }
  static void WriteEnt(StringBuilder sb, Ent e) {
    sb.Append("{\"id\":"); Str(sb, e.Id); sb.Append(",\"type\":"); Str(sb, e.Type); sb.Append(",\"props\":{");
    for (int i = 0; i < e.Props.Count; i++) { if (i > 0) sb.Append(','); Str(sb, e.Props[i].Key); sb.Append(':'); Value(sb, e.Props[i].Value); }
    sb.Append("},\"record\":"); Str(sb, e.Record);
    if (e.Components != null) { sb.Append(",\"components\":["); for (int i = 0; i < e.Components.Count; i++) { if (i > 0) sb.Append(','); WriteEnt(sb, e.Components[i]); } sb.Append(']'); }
    sb.Append('}');
  }

  // ---- canonical digest (must match native/jww-worker.mjs entityDigest) ----------------------------------------------
  static void Enc(StringBuilder sb, object v) {
    if (v == null) { sb.Append('N'); return; }
    if (v is string) { sb.Append('S').Append((string)v); return; }
    if (v is bool) { sb.Append((bool)v ? 'T' : 'F'); return; }
    double d = System.Convert.ToDouble(v, Inv);
    if (double.IsNaN(d) || double.IsInfinity(d)) { sb.Append('N'); return; }
    if (d == 0) d = 0.0;
    sb.Append('D').Append(BitConverter.DoubleToInt64Bits(d).ToString("x16"));
  }
  static void Canon(StringBuilder sb, Ent e) {
    sb.Append(e.Type).Append('\u001f');
    var props = new List<KeyValuePair<string, object>>(e.Props);
    props.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
    foreach (var p in props) { sb.Append(p.Key).Append('='); Enc(sb, p.Value); sb.Append('\u001e'); }
    if (e.Components != null) { sb.Append('{'); foreach (var c in e.Components) Canon(sb, c); sb.Append('}'); }
    sb.Append('\u001d');
  }
  static string Digest(StringBuilder canon) {
    using (var sha = SHA256.Create()) {
      byte[] h = sha.ComputeHash(Encoding.UTF8.GetBytes(canon.ToString()));
      var sb = new StringBuilder(16); for (int i = 0; i < 8; i++) sb.Append(h[i].ToString("x2")); return sb.ToString();
    }
  }
  static string EntDigest(Ent e) { var sb = new StringBuilder(); Canon(sb, e); return Digest(sb); }

  // ---- document --------------------------------------------------------------------------------------------------------
  class BlockInfo { public string Id, Name; public int Number, Declared; public List<Ent> Children; }
  class Doc { public int Version, BlockSize, Images; public List<Ent> Entities = new List<Ent>(); public List<BlockInfo> Blocks = new List<BlockInfo>(); public StringBuilder Layers = new StringBuilder(), ImageMeta = new StringBuilder(); public Ctx Ctx; public string Header; }

  static Doc ReadDoc(string path, bool withHeader) {
    if (!File.Exists(path)) throw new Exception("E_JWW_INPUT missing file");
    object reader = Activator.CreateInstance(ReaderT);
    try {
      ReaderT.GetMethod("Read").Invoke(reader, new object[] { path, null });
      object header = Get(reader, "Header");
      var doc = new Doc(); var ctx = new Ctx(); doc.Ctx = ctx;
      ctx.Version = System.Convert.ToInt32(Get(header, "m_jwwDataVersion")); doc.Version = ctx.Version;
      int index = 0;
      foreach (object entity in (System.Collections.IEnumerable)Get(reader, "DataList")) {
        doc.Entities.Add(Convert1(entity, "e" + index, 0, ctx)); index++;
        if (index > EntityLimit) throw new Exception("E_JWW_ENTITY_LIMIT");
      }
      int bi = 0;
      foreach (object block in (System.Collections.IEnumerable)Get(reader, "DataListList")) {
        var info = new BlockInfo { Id = "b" + bi, Children = new List<Ent>() };
        var col = new Collector(); var children = info.Children; string bid = info.Id;
        col.Fn = child => { children.Add(Convert1(child, bid + "/e" + children.Count, 0, ctx)); return true; };
        var del = Delegate.CreateDelegate(CallbackT, col, typeof(Collector).GetMethod("Add"));
        block.GetType().GetMethod("EnumerateDataList").Invoke(block, new object[] { del });
        info.Number = System.Convert.ToInt32(Get(block, "m_nNumber")); info.Name = (string)Get(block, "m_strName");
        info.Declared = System.Convert.ToInt32(block.GetType().GetMethod("GetSize").Invoke(block, null));
        doc.Blocks.Add(info);
        if (children.Count != info.Declared) Diag(ctx, "BLOCK_CHILDREN_SKIPPED", "blockId", bid, null);
        bi++;
      }
      var images = (Array)Get(reader, "Images"); doc.Images = images == null ? 0 : images.Length;
      doc.ImageMeta.Append('[');
      if (images != null) for (int i = 0; i < images.Length; i++) {
        if (i > 0) doc.ImageMeta.Append(',');
        object img = images.GetValue(i);
        doc.ImageMeta.Append("{\"name\":"); Str(doc.ImageMeta, (string)Get(img, "ImageName")); doc.ImageMeta.Append(",\"compressedBytes\":").Append(System.Convert.ToString(Get(img, "Size"), Inv)).Append('}');
      }
      doc.ImageMeta.Append(']');
      object gnames = Get(header, "m_aStrGLayName"), lnames = Get(header, "m_aStrLayName"), scales = Get(header, "m_adScale"), states = Get(header, "m_aanLay");
      doc.Layers.Append('[');
      for (int g = 0; g < 16; g++) for (int l = 0; l < 16; l++) {
        if (g + l > 0) doc.Layers.Append(',');
        doc.Layers.Append("{\"id\":\"").Append(string.Format("{0:X}:{1:X}", g, l)).Append("\",\"groupName\":"); Str(doc.Layers, (string)Item(gnames, g));
        doc.Layers.Append(",\"name\":"); Str(doc.Layers, (string)Item(((Array)lnames).GetValue(g), l));
        doc.Layers.Append(",\"scale\":"); Value(doc.Layers, Item(scales, g));
        doc.Layers.Append(",\"state\":"); Value(doc.Layers, Item(((Array)states).GetValue(g), l)); doc.Layers.Append('}');
      }
      doc.Layers.Append(']');
      doc.BlockSize = System.Convert.ToInt32(ReaderT.GetMethod("GetBlockSize").Invoke(reader, null));
      if (withHeader) doc.Header = HeaderJson(header);
      return doc;
    } catch (TargetInvocationException ex) { throw ex.InnerException ?? ex; }
    finally { var d = reader as IDisposable; if (d != null) d.Dispose(); }
  }
  static object Item(object arr, int i) { return arr.GetType().GetMethod("get_Item").Invoke(arr, new object[] { i }); }

  static void DocHead(StringBuilder sb, Doc doc) {
    sb.Append("{\"readerSchemaVersion\":2,\"version\":").Append(doc.Version).Append(",\"layers\":").Append(doc.Layers);
  }
  static void DocTail(StringBuilder sb, Doc doc) {
    sb.Append(",\"blockDefinitions\":").Append(doc.BlockSize).Append(",\"images\":").Append(doc.Images).Append(",\"imageMetadata\":").Append(doc.ImageMeta)
      .Append(",\"diagnostics\":[").Append(doc.Ctx.Diag).Append("]}");
  }
  static void WriteBlocks(StringBuilder sb, Doc doc) {
    sb.Append('[');
    for (int b = 0; b < doc.Blocks.Count; b++) {
      var info = doc.Blocks[b]; if (b > 0) sb.Append(',');
      sb.Append("{\"id\":"); Str(sb, info.Id); sb.Append(",\"number\":").Append(info.Number).Append(",\"name\":"); Str(sb, info.Name);
      sb.Append(",\"declaredCount\":").Append(info.Declared).Append(",\"entities\":[");
      for (int i = 0; i < info.Children.Count; i++) { if (i > 0) sb.Append(','); WriteEnt(sb, info.Children[i]); }
      sb.Append("]}");
    }
    sb.Append(']');
  }
  static string BlocksDigest(Doc doc) {
    var sb = new StringBuilder();
    foreach (var info in doc.Blocks) {
      sb.Append('B'); Enc(sb, info.Number); sb.Append('\u001e'); Enc(sb, info.Name); sb.Append('\u001e'); Enc(sb, info.Declared); sb.Append('\u001e');
      foreach (var c in info.Children) Canon(sb, c);
      sb.Append('\u001c');
    }
    return Digest(sb);
  }

  static string ReadJson(string path, bool withHeader) {
    var doc = ReadDoc(path, withHeader); var sb = new StringBuilder(1 << 20);
    if (withHeader) sb.Append("{\"header\":").Append(doc.Header).Append(",\"document\":");
    DocHead(sb, doc);
    sb.Append(",\"entities\":[");
    for (int i = 0; i < doc.Entities.Count; i++) { if (i > 0) sb.Append(','); WriteEnt(sb, doc.Entities[i]); }
    sb.Append("],\"blocks\":"); WriteBlocks(sb, doc);
    DocTail(sb, doc);
    if (withHeader) sb.Append('}');
    return sb.ToString();
  }
  // digests: 16 hex chars per expected entity (any placeholder for touched ones); full: indices always shipped.
  static string VerifyJson(string path, string digests, HashSet<int> full, int maxShipped) {
    var doc = ReadDoc(path, true); var sb = new StringBuilder(1 << 16);
    sb.Append("{\"header\":").Append(doc.Header).Append(",\"document\":");
    DocHead(sb, doc);
    int expected = digests.Length / 16, mismatches = 0, shipped = 0;
    sb.Append(",\"entities\":null,\"entityCount\":").Append(doc.Entities.Count).Append(",\"shipped\":{");
    for (int i = 0; i < doc.Entities.Count; i++) {
      bool want = full.Contains(i) || i >= expected;
      if (!want && string.CompareOrdinal(EntDigest(doc.Entities[i]), 0, digests, i * 16, 16) != 0) { want = true; mismatches++; }
      if (!want) continue;
      if (shipped >= maxShipped && !full.Contains(i)) continue;
      if (shipped > 0) sb.Append(',');
      sb.Append('"').Append(i).Append("\":"); WriteEnt(sb, doc.Entities[i]); shipped++;
    }
    sb.Append("},\"digestMismatches\":").Append(mismatches).Append(",\"blocks\":null,\"blockCount\":").Append(doc.Blocks.Count)
      .Append(",\"blocksDigest\":\"").Append(BlocksDigest(doc)).Append('"');
    DocTail(sb, doc);
    sb.Append('}');
    return sb.ToString();
  }

  // ---- header (Write-Jww.ps1 -Mode Header, including PowerShell array unrolling) --------------------------------------
  static void Flatten(object v, List<object> into, int depth) {
    if (depth > 4) throw new Exception("header nesting");
    if (v is Array) { foreach (object x in (Array)v) Flatten(x, into, depth + 1); return; }
    if (v != null && !(v is string) && !(v is ValueType)) {
      var t = v.GetType();
      if (t.Name.StartsWith("WrapArray") || t.Name == "CStringArray") {
        int n = System.Convert.ToInt32(t.GetProperty("Length").GetValue(v, null)); var item = t.GetMethod("get_Item");
        for (int i = 0; i < n; i++) Flatten(item.Invoke(v, new object[] { i }), into, depth + 1);
        return;
      }
      into.Add(null); return;
    }
    if (v is double && (double.IsNaN((double)v) || double.IsInfinity((double)v))) v = null;
    into.Add(v);
  }
  static string HeaderJson(object header) {
    var sb = new StringBuilder(16384);
    sb.Append("{\"acp\":").Append(Encoding.Default.CodePage);
    foreach (var pi in header.GetType().GetProperties()) {
      object v = pi.GetValue(header, null);
      sb.Append(','); Str(sb, pi.Name); sb.Append(':');
      bool list = v is Array || (v != null && (v.GetType().Name.StartsWith("WrapArray") || v.GetType().Name == "CStringArray"));
      if (!list) { if (v is double && (double.IsNaN((double)v) || double.IsInfinity((double)v))) v = null; if (v != null && !(v is string) && !(v is ValueType)) v = null; Value(sb, v); continue; }
      var items = new List<object>(); Flatten(v, items, 0);
      if (items.Count == 0) sb.Append("null");
      else if (items.Count == 1) Value(sb, items[0]);
      else { sb.Append('['); for (int i = 0; i < items.Count; i++) { if (i > 0) sb.Append(','); Value(sb, items[i]); } sb.Append(']'); }
    }
    sb.Append('}');
    return sb.ToString();
  }
  static string HeaderOnly(string path) {
    if (!File.Exists(path)) throw new Exception("E_JWW_INPUT missing file");
    object reader = Activator.CreateInstance(ReaderT);
    try { ReaderT.GetMethod("Read").Invoke(reader, new object[] { path, null }); return HeaderJson(Get(reader, "Header")); }
    catch (TargetInvocationException ex) { throw ex.InnerException ?? ex; }
    finally { var d = reader as IDisposable; if (d != null) d.Dispose(); }
  }

  // ---- loop ------------------------------------------------------------------------------------------------------------
  public static void Serve() {
    var utf8 = new UTF8Encoding(false);
    var input = new StreamReader(Console.OpenStandardInput(), utf8);
    var output = new StreamWriter(Console.OpenStandardOutput(), utf8); output.AutoFlush = false; output.NewLine = "\n";
    var json = new JavaScriptSerializer(); json.MaxJsonLength = int.MaxValue;
    output.WriteLine("{\"ready\":true,\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"protocol\":1}"); output.Flush();
    string line;
    while ((line = input.ReadLine()) != null) {
      if (line.Length == 0) continue;
      string id = "null", result = null, code = null, message = null; bool stop = false;
      try {
        var req = (Dictionary<string, object>)json.DeserializeObject(line);
        id = System.Convert.ToString(req["id"], Inv);
        string cmd = (string)req["cmd"];
        switch (cmd) {
          case "ping": result = "\"pong\""; break;
          case "sleep": Thread.Sleep(System.Convert.ToInt32(req["ms"])); result = "null"; break;
          case "shutdown": result = "null"; stop = true; break;
          case "read": result = ReadJson((string)req["path"], req.ContainsKey("header") && true.Equals(req["header"])); break;
          case "header": result = HeaderOnly((string)req["path"]); break;
          case "verify": {
            var full = new HashSet<int>();
            if (req.ContainsKey("full") && req["full"] != null) foreach (object o in (object[])req["full"]) full.Add(System.Convert.ToInt32(o));
            int max = req.ContainsKey("maxShipped") ? System.Convert.ToInt32(req["maxShipped"]) : 2000;
            result = VerifyJson((string)req["path"], (string)req["digests"] ?? "", full, max); break;
          }
          default: code = "E_JWW_WORKER_COMMAND"; message = cmd; break;
        }
      } catch (Exception ex) {
        var inner = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
        message = inner.Message; code = message.StartsWith("E_JWW_") ? message.Split(' ')[0] : "E_JWW_NATIVE_READ";
      }
      var sb = new StringBuilder();
      sb.Append("{\"id\":").Append(id);
      if (code == null) sb.Append(",\"ok\":true,\"result\":").Append(result).Append('}');
      else { sb.Append(",\"ok\":false,\"error\":{\"code\":"); Str(sb, code); sb.Append(",\"message\":"); Str(sb, message); sb.Append("}}"); }
      output.WriteLine(sb.ToString()); output.Flush();
      if (stop) break;
    }
  }
}
'@
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $dll = Join-Path $PSScriptRoot 'vendor/JwwHelper_x64.dll'
  [void][Reflection.Assembly]::LoadFrom($dll)
  Add-Type -AssemblyName System.Web.Extensions
  Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.Web.Extensions')
  [FrescoJwwWorker]::Init($dll)
} catch {
  [Console]::Error.WriteLine(('E_JWW_WORKER_START: ' + $_.Exception.Message))
  exit 1
}
[FrescoJwwWorker]::Serve()

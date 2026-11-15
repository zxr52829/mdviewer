/**
 * 内置符号库：常见语言的标准库 / 关键字 / 内置类型。
 *
 * 定位说明：Trae 的真实补全来自语言服务（Pylance / clangd / JSON LS），
 * 那是独立进程 + 完整类型推断，本项不试图复现。这里提供的是**离线可用的
 * 高价值符号表**——覆盖日常写代码时最常敲的那些名字，足以让补全有实用价值。
 *
 * 组织方式按「语言 → 分类」，每类给一组符号。分类决定候选的 detail 文字，
 * 便于用户在列表里区分是关键字、内置函数还是标准库成员。
 */

/** 通用：所有语言都补的控制流关键字 */
const COMMON_KEYWORDS = [
  'if', 'else', 'for', 'while', 'return', 'break', 'continue', 'switch',
  'case', 'default', 'do', 'goto', 'sizeof', 'typedef', 'struct', 'union',
  'enum', 'static', 'const', 'extern', 'volatile', 'inline',
];

const LIBRARIES = {
  /* ==================== C ==================== */
  c: {
    关键字: [
      'auto', 'char', 'double', 'float', 'int', 'long', 'short', 'signed',
      'unsigned', 'void', 'restrict', '_Bool', '_Complex', '_Static_assert',
      ...COMMON_KEYWORDS,
    ],
    标准库: [
      // stdio.h
      'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
      'fopen', 'fclose', 'fread', 'fwrite', 'fseek', 'ftell', 'fgets', 'fputs',
      'getchar', 'putchar', 'puts', 'fflush', 'perror', 'remove', 'rename',
      'FILE', 'EOF', 'stdin', 'stdout', 'stderr',
      // stdlib.h
      'malloc', 'calloc', 'realloc', 'free', 'exit', 'abort', 'atexit',
      'atoi', 'atol', 'atof', 'strtol', 'strtod', 'rand', 'srand',
      'qsort', 'bsearch', 'abs', 'labs', 'div', 'system', 'getenv',
      'NULL', 'EXIT_SUCCESS', 'EXIT_FAILURE',
      // string.h
      'memcpy', 'memmove', 'memset', 'memcmp', 'strcpy', 'strncpy', 'strcat',
      'strncat', 'strcmp', 'strncmp', 'strlen', 'strchr', 'strrchr', 'strstr',
      'strtok', 'strdup', 'strerror',
      // math.h
      'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sqrt', 'pow',
      'exp', 'log', 'log10', 'fabs', 'floor', 'ceil', 'round', 'fmod',
      // ctype.h
      'isalpha', 'isdigit', 'isalnum', 'isspace', 'isupper', 'islower',
      'toupper', 'tolower',
      // stdint.h / stdbool.h
      'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t',
      'uint32_t', 'uint64_t', 'size_t', 'ssize_t', 'ptrdiff_t', 'intptr_t',
      'uintptr_t', 'bool', 'true', 'false',
    ],
    宏: ['NULL', 'EOF', 'BUFSIZ', 'RAND_MAX', 'INT_MAX', 'INT_MIN', 'UINT_MAX'],
  },

  /* ==================== C++ ==================== */
  cpp: {
    关键字: [
      'alignas', 'alignof', 'auto', 'bool', 'char', 'char8_t', 'char16_t',
      'char32_t', 'class', 'concept', 'const', 'consteval', 'constexpr',
      'constinit', 'const_cast', 'co_await', 'co_return', 'co_yield', 'decltype',
      'delete', 'dynamic_cast', 'explicit', 'export', 'friend', 'mutable',
      'namespace', 'new', 'noexcept', 'nullptr', 'operator', 'override',
      'private', 'protected', 'public', 'reinterpret_cast', 'requires',
      'static_assert', 'static_cast', 'template', 'this', 'throw', 'try',
      'catch', 'typeid', 'typename', 'using', 'virtual', 'wchar_t', 'final',
      ...COMMON_KEYWORDS,
    ],
    'std 容器': [
      'std::vector', 'std::array', 'std::deque', 'std::list', 'std::forward_list',
      'std::map', 'std::set', 'std::multimap', 'std::multiset',
      'std::unordered_map', 'std::unordered_set', 'std::stack', 'std::queue',
      'std::priority_queue', 'std::pair', 'std::tuple', 'std::optional',
      'std::variant', 'std::any', 'std::string', 'std::string_view',
      'std::wstring', 'std::bitset',
    ],
    'std 算法': [
      'std::sort', 'std::stable_sort', 'std::find', 'std::find_if',
      'std::count', 'std::count_if', 'std::transform', 'std::for_each',
      'std::accumulate', 'std::copy', 'std::copy_if', 'std::remove',
      'std::remove_if', 'std::unique', 'std::reverse', 'std::fill',
      'std::min', 'std::max', 'std::min_element', 'std::max_element',
      'std::clamp', 'std::swap', 'std::lower_bound', 'std::upper_bound',
      'std::binary_search', 'std::all_of', 'std::any_of', 'std::none_of',
    ],
    'std 工具': [
      'std::move', 'std::forward', 'std::make_unique', 'std::make_shared',
      'std::unique_ptr', 'std::shared_ptr', 'std::weak_ptr',
      'std::enable_shared_from_this', 'std::function', 'std::bind',
      'std::ref', 'std::cref', 'std::invoke', 'std::size', 'std::begin', 'std::end',
      'std::to_string', 'std::stoi', 'std::stol', 'std::stod', 'std::stod',
    ],
    'std 输入输出': [
      'std::cout', 'std::cin', 'std::cerr', 'std::clog', 'std::endl',
      'std::ifstream', 'std::ofstream', 'std::fstream', 'std::stringstream',
      'std::getline', 'std::setw', 'std::setprecision', 'std::fixed',
    ],
  },

  /* ==================== Python ==================== */
  python: {
    关键字: [
      'def', 'class', 'return', 'yield', 'lambda', 'if', 'elif', 'else',
      'for', 'while', 'break', 'continue', 'pass', 'import', 'from', 'as',
      'with', 'try', 'except', 'else', 'finally', 'raise', 'assert', 'del',
      'global', 'nonlocal', 'async', 'await', 'in', 'is', 'not', 'and', 'or',
      'True', 'False', 'None', 'match', 'case',
    ],
    内置函数: [
      'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
      'reversed', 'sum', 'min', 'max', 'abs', 'round', 'divmod', 'pow',
      'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
      'delattr', 'callable', 'repr', 'str', 'int', 'float', 'bool', 'bytes',
      'bytearray', 'list', 'tuple', 'dict', 'set', 'frozenset', 'object',
      'super', 'property', 'staticmethod', 'classmethod', 'iter', 'next',
      'open', 'input', 'format', 'hash', 'id', 'vars', 'dir', 'globals',
      'locals', 'eval', 'exec', 'compile', 'any', 'all', 'chr', 'ord',
      'hex', 'oct', 'bin', 'slice', 'memoryview',
    ],
    '内置异常': [
      'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError',
      'IndexError', 'AttributeError', 'RuntimeError', 'StopIteration',
      'OSError', 'IOError', 'FileNotFoundError', 'PermissionError',
      'ZeroDivisionError', 'ImportError', 'ModuleNotFoundError',
      'NotImplementedError', 'AssertionError',
    ],
    '常用模块': [
      'os', 'sys', 're', 'json', 'math', 'time', 'datetime', 'random',
      'collections', 'itertools', 'functools', 'pathlib', 'typing',
      'subprocess', 'threading', 'asyncio', 'logging', 'argparse',
      'dataclasses', 'enum', 'shutil', 'tempfile', 'hashlib', 'base64',
      'csv', 'sqlite3', 'urllib', 'http', 'socket', 'struct', 'unittest',
    ],
    '模块成员': [
      'os.path', 'os.getcwd', 'os.listdir', 'os.makedirs', 'os.environ',
      'os.path.join', 'os.path.exists', 'os.path.basename', 'os.path.dirname',
      'os.path.abspath', 'sys.argv', 'sys.exit', 'sys.path', 'sys.stdout',
      'sys.stderr', 'json.loads', 'json.dumps', 'json.load', 'json.dump',
      're.match', 're.search', 're.findall', 're.sub', 're.compile',
      'math.sqrt', 'math.pi', 'math.floor', 'math.ceil', 'math.inf',
      'time.time', 'time.sleep', 'datetime.now', 'datetime.timedelta',
      'random.randint', 'random.choice', 'random.shuffle', 'random.random',
      'collections.defaultdict', 'collections.Counter', 'collections.deque',
      'functools.wraps', 'functools.partial', 'functools.reduce',
      'itertools.chain', 'itertools.product', 'itertools.combinations',
    ],
    '魔术方法': [
      '__init__', '__str__', '__repr__', '__len__', '__getitem__',
      '__setitem__', '__iter__', '__next__', '__enter__', '__exit__',
      '__eq__', '__lt__', '__hash__', '__call__', '__name__', '__main__',
    ],
  },

  /* ==================== JSON ==================== */
  json: {
    字面量: ['true', 'false', 'null'],
  },

  /* ==================== JavaScript / TypeScript ==================== */
  javascript: {
    关键字: [
      'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for',
      'while', 'do', 'switch', 'case', 'break', 'continue', 'class', 'extends',
      'super', 'this', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of',
      'import', 'export', 'from', 'default', 'async', 'await', 'try', 'catch',
      'finally', 'throw', 'yield', 'static', 'get', 'set', 'true', 'false',
      'null', 'undefined', 'NaN', 'Infinity',
    ],
    内置对象: [
      'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number',
      'Boolean', 'Date', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet',
      'Promise', 'Symbol', 'Proxy', 'Reflect', 'Error', 'TypeError',
      'window', 'document', 'localStorage', 'sessionStorage', 'fetch',
      'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
      'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent',
      'decodeURIComponent', 'structuredClone',
    ],
    常用方法: [
      'console.log', 'console.error', 'console.warn', 'console.table',
      'JSON.parse', 'JSON.stringify', 'Object.keys', 'Object.values',
      'Object.entries', 'Object.assign', 'Object.freeze', 'Array.from',
      'Array.isArray', 'Promise.all', 'Promise.race', 'Promise.resolve',
      'document.querySelector', 'document.querySelectorAll',
      'document.getElementById', 'document.createElement',
      'element.addEventListener', 'element.appendChild',
      'element.classList.add', 'element.classList.remove',
    ],
  },
  typescript: {
    关键字: [
      'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for',
      'while', 'switch', 'case', 'class', 'extends', 'implements', 'interface',
      'type', 'enum', 'namespace', 'declare', 'abstract', 'public', 'private',
      'protected', 'readonly', 'static', 'as', 'satisfies', 'keyof',
      'infer', 'is', 'asserts', 'import', 'export', 'from', 'default',
      'async', 'await', 'try', 'catch', 'finally', 'throw', 'true', 'false',
      'null', 'undefined', 'never', 'unknown', 'any', 'void', 'string',
      'number', 'boolean', 'object', 'symbol', 'bigint',
    ],
  },

  /* ==================== Go ==================== */
  go: {
    关键字: [
      'break', 'case', 'chan', 'const', 'continue', 'default', 'defer',
      'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import',
      'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
      'switch', 'type', 'var', 'nil', 'true', 'false', 'iota',
    ],
    内置: [
      'append', 'cap', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
      'make', 'new', 'panic', 'print', 'println', 'real', 'recover',
      'error', 'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint',
      'uint8', 'uint16', 'uint32', 'uint64', 'uintptr', 'byte', 'rune',
      'float32', 'float64', 'complex64', 'complex128', 'bool',
    ],
    标准库: [
      'fmt', 'os', 'io', 'strings', 'strconv', 'errors', 'time', 'sort',
      'sync', 'context', 'net', 'http', 'json', 'log', 'path', 'filepath',
      'bytes', 'bufio', 'regexp', 'math', 'rand', 'reflect', 'runtime',
      'fmt.Println', 'fmt.Printf', 'fmt.Sprintf', 'fmt.Errorf', 'fmt.Fprintf',
      'errors.New', 'errors.Is', 'errors.As', 'strings.Split', 'strings.Join',
      'strings.TrimSpace', 'strings.Contains', 'strings.Replace',
      'strconv.Itoa', 'strconv.Atoi', 'os.Open', 'os.Create', 'os.ReadFile',
      'os.WriteFile', 'io.ReadAll', 'log.Fatal', 'log.Printf',
    ],
  },

  /* ==================== Java ==================== */
  java: {
    关键字: [
      'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch',
      'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else',
      'enum', 'extends', 'final', 'finally', 'float', 'for', 'if',
      'implements', 'import', 'instanceof', 'int', 'interface', 'long',
      'native', 'new', 'package', 'private', 'protected', 'public', 'return',
      'short', 'static', 'strictfp', 'super', 'switch', 'synchronized',
      'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile',
      'while', 'true', 'false', 'null', 'var', 'record', 'sealed',
    ],
    核心类: [
      'String', 'StringBuilder', 'StringBuffer', 'Integer', 'Long', 'Double',
      'Float', 'Boolean', 'Character', 'Object', 'List', 'ArrayList',
      'LinkedList', 'Map', 'HashMap', 'LinkedHashMap', 'TreeMap', 'Set',
      'HashSet', 'TreeSet', 'Queue', 'Deque', 'ArrayDeque', 'Optional',
      'Stream', 'Collectors', 'Arrays', 'Collections', 'Math', 'System',
      'File', 'Path', 'Paths', 'Files', 'Exception', 'RuntimeException',
      'IOException', 'Thread', 'ExecutorService', 'CompletableFuture',
    ],
    常用方法: [
      'System.out.println', 'System.out.print', 'System.err.println',
      'System.currentTimeMillis', 'String.valueOf', 'String.format',
      'Integer.parseInt', 'Integer.valueOf', 'Double.parseDouble',
      'list.add', 'list.get', 'list.size', 'list.isEmpty', 'list.stream',
      'map.put', 'map.get', 'map.containsKey', 'map.keySet', 'map.entrySet',
      'stream.filter', 'stream.map', 'stream.collect', 'stream.forEach',
      'Collectors.toList', 'Collectors.joining',
    ],
  },

  /* ==================== Markdown ==================== */
  markdown: {},
};

/** 把某个语言的符号库展开成扁平数组（含分类） */
export function getLibrarySymbols(languageId) {
  const lib = LIBRARIES[languageId] || LIBRARIES[languageId.replace(/\d+$/, '')];
  if (!lib) return [];

  const out = [];
  for (const [category, words] of Object.entries(lib)) {
    for (const w of words) {
      out.push({ label: w, detail: category, kind: categoryToKind(category) });
    }
  }
  return out;
}

function categoryToKind(category) {
  if (category.includes('关键字') || category.includes('字面量')) return 'keyword';
  if (category.includes('异常')) return 'exception';
  if (category.includes('模块') || category.includes('标准库') || category.includes('内置对象')) return 'module';
  if (category.includes('方法') || category.includes('函数')) return 'function';
  if (category.includes('容器') || category.includes('算法') || category.includes('工具')) return 'function';
  return 'library';
}

/** 该语言是否有内置符号库 */
export function hasLibrary(languageId) {
  return !!LIBRARIES[languageId];
}

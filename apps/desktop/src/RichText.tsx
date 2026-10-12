import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { isValidElement, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Code, Image } from 'lucide-react';
import { CopyButton } from './copy.tsx';

// A finished drawing in a block of `svg` is shown as the picture it is, its source one click away. As an image
// it runs no script and loads nothing from elsewhere.
function drawing(children: ReactNode) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: source } = children.props;
  if (!/\blanguage-svg\b/.test(className ?? '') || typeof source !== 'string') return null;
  return /<svg[\s>]/.test(source) && source.includes('</svg>') ? source : null;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const block = useRef<HTMLPreElement>(null);
  const svg = drawing(children);
  const [shown, setShown] = useState<'picture' | 'source' | 'broken'>('picture');
  const picture = svg !== null && shown === 'picture';
  return (
    <div className="code-block">
      {picture ? (
        <img
          className="code-picture"
          alt="SVG 图像"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
          onError={() => setShown('broken')}
        />
      ) : (
        <pre ref={block}>{children}</pre>
      )}
      <span className="code-actions" data-search-ignore>
        {svg !== null && shown !== 'broken' && (
          <button
            type="button"
            className="copy-button"
            onClick={() => setShown(picture ? 'source' : 'picture')}
          >
            {picture ? <Code /> : <Image />}
            <span>{picture ? '查看源码' : '查看图像'}</span>
          </button>
        )}
        <CopyButton text={() => svg ?? block.current?.textContent ?? ''} label="复制代码" />
      </span>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// Formulas are also written as \( … \) and \[ … \], which Markdown would read as escaped brackets; outside of
// code they become the dollar form the parser knows.
const fence = '^ {0,3}(?:`{3,}|~{3,})';
const code = new RegExp(
  `(${fence}[\\s\\S]*?(?:${fence}[^\\S\\n]*$|(?![\\s\\S]))|\`[^\`\\n]*\`)`,
  'm',
);
export function dollars(text: string) {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  return text
    .split(code)
    .map((part, index) =>
      // Prose and code alternate, prose first.
      index % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, formula: string) => `$$${formula}$$`)
            .replace(/\\\(([^\n]+?)\\\)/g, (_, formula: string) => `$${formula}$`),
    )
    .join('');
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: [typeof rehypeKatex, { strict: boolean }][] = [
  [rehypeKatex, { strict: false }],
];

export default function RichText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      skipHtml
      components={components}
    >
      {dollars(text)}
    </Markdown>
  );
}

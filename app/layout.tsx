import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title:'裁纸台 · PDF 可视化编辑',description:'裁剪与缩放、PDF 转 Word、扫描文字识别、多个 PDF 合并及按页码分割，文件在本机处理。',icons:{icon:'/favicon.svg'} };
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) { return <html lang="zh-CN"><body>{children}</body></html>; }

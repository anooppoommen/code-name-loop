import { File, FileCode2, FileImage, FileJson, FileText } from 'lucide-react';

export function getPatchFileIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp'].includes(ext)) {
    return <FileCode2 size={14} className="text-blue-400" />;
  }
  if (['json', 'yaml', 'yml'].includes(ext)) {
    return <FileJson size={14} className="text-yellow-400" />;
  }
  if (['md', 'txt', 'csv'].includes(ext)) {
    return <FileText size={14} className="text-loop-400" />;
  }
  if (['png', 'jpg', 'jpeg', 'svg', 'gif'].includes(ext)) {
    return <FileImage size={14} className="text-purple-400" />;
  }
  return <File size={14} className="text-loop-500" />;
}

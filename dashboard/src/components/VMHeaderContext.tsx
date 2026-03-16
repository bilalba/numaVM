import { createContext, useContext, useState, type ReactNode } from "react";

interface VMHeaderData {
  name: string;
  status: string;
  memSizeMib: number;
  role: string;
  vmId: string;
}

const VMHeaderContext = createContext<{
  vm: VMHeaderData | null;
  setVM: (vm: VMHeaderData | null) => void;
}>({ vm: null, setVM: () => {} });

export function VMHeaderProvider({ children }: { children: ReactNode }) {
  const [vm, setVM] = useState<VMHeaderData | null>(null);
  return (
    <VMHeaderContext.Provider value={{ vm, setVM }}>
      {children}
    </VMHeaderContext.Provider>
  );
}

export function useVMHeader() {
  return useContext(VMHeaderContext);
}

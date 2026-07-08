import { MantineProvider } from '@mantine/core';

import { Inicio } from './pages/Inicio';
import { cssVariablesResolver, theme } from './theme';

export function App() {
  return (
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
      <Inicio />
    </MantineProvider>
  );
}

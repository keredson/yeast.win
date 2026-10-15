import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import { App } from './App.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={{ token: {
      colorPrimary: '#1f6b5b', colorInfo: '#1f6b5b', colorSuccess: '#568f60',
      colorBgBase: '#faf8f2', colorTextBase: '#243b36', borderRadius: 10,
      fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif'
    } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>
);

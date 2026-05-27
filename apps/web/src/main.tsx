/* @refresh reload */
import './styles/global.css';

import { render } from 'solid-js/web';
import { Router, Route } from '@solidjs/router';
import { App } from './App.js';
import { HomePage } from './routes/home.js';
import { LoginPage } from './routes/login.js';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found in index.html');

render(
  () => (
    <Router root={App}>
      <Route path="/" component={HomePage} />
      <Route path="/login" component={LoginPage} />
    </Router>
  ),
  root,
);

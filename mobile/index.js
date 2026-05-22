import { AppRegistry } from 'react-native';
import App from './App';
import BackgroundFetch from 'react-native-background-fetch';
import { headlessTask } from './src/tasks/backgroundSync';

AppRegistry.registerComponent('ApolloSFS', () => App);

// Android: run sync when app is terminated
BackgroundFetch.registerHeadlessTask(headlessTask);

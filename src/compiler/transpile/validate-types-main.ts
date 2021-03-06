import * as d from '../../declarations';
import { BuildContext } from '../build/build-ctx';
import { getComponentsDtsSrcFilePath } from '../distribution/distribution';
import { getUserCompilerOptions } from './compiler-options';


export async function validateTypesMain(config: d.Config, compilerCtx: d.CompilerCtx, buildCtx: d.BuildCtx) {
  if (!buildCtx.isActiveBuild) {
    buildCtx.debug(`validateTypesMain aborted, not active build`);
    return;
  }

  if (buildCtx.hasError) {
    buildCtx.debug(`validateTypesMain aborted`);
    return;
  }

  // send data over to our worker process to validate types
  // don't let this block the main thread and we'll check
  // its response sometime later
  const timeSpan = buildCtx.createTimeSpan(`validateTypes started`, true);

  const componentsDtsSrcFilePath = getComponentsDtsSrcFilePath(config);
  const rootTsFiles = compilerCtx.rootTsFiles.slice();

  // ensure components.d.ts IS in the type validation transpile
  if (!rootTsFiles.includes(componentsDtsSrcFilePath)) {
    rootTsFiles.push(componentsDtsSrcFilePath);
  }

  const collectionNames = compilerCtx.collections.map(c => c.collectionName);

  buildCtx.validateTypesHandler = (results: d.ValidateTypesResults) => {
    timeSpan.finish(`validateTypes finished`);

    compilerCtx.fs.cancelDeleteDirectoriesFromDisk(results.dirPaths);
    compilerCtx.fs.cancelDeleteFilesFromDisk(results.filePaths);

    if (results.diagnostics.length === 0) {
      // no harm, no foul
      // null it out so we know there's nothing to wait on
      buildCtx.validateTypesHandler = null;
      buildCtx.validateTypesPromise = null;
      return;
    }

    if (buildCtx.hasFinished) {
      // the build has already finished before the
      // type checking transpile finished, which is fine for watch
      // we'll need to create build to show the diagnostics
      if (buildCtx.isActiveBuild) {
        buildCtx.debug(`validateTypesHandler, build already finished, creating a new build`);
        const diagnosticsBuildCtx = new BuildContext(config, compilerCtx);
        diagnosticsBuildCtx.start();
        diagnosticsBuildCtx.diagnostics.push(...results.diagnostics);
        diagnosticsBuildCtx.finish();
      }

    } else {
      // cool the build hasn't finished yet
      // so let's add the diagnostics to the build now
      // so that the current build will print these
      buildCtx.diagnostics.push(...results.diagnostics);

      // null out so we don't try this again
      buildCtx.validateTypesHandler = null;
      buildCtx.validateTypesPromise = null;

      buildCtx.finish();
    }
  };

  // get the typescript compiler options
  const compilerOptions = await getUserCompilerOptions(config, compilerCtx);

  // only write dts files when we have an output target with a types directory
  const emitDtsFiles = (config.outputTargets as d.OutputTargetDist[]).some(o => !!o.typesDir);

  // kick off validating types by sending the data over to the worker process
  buildCtx.validateTypesPromise = config.sys.validateTypes(compilerOptions, emitDtsFiles, config.cwd, collectionNames, rootTsFiles);

  // when the validate types build finishes
  // let's run the handler we put on the build context
  buildCtx.validateTypesPromise.then(buildCtx.validateTypesHandler.bind(buildCtx));
}
